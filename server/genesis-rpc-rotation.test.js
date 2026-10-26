import { describe, expect, it, vi } from "vitest";
import { Interface, Wallet, getAddress, id } from "ethers";
import { GENESIS_CHAIN_ID, GENESIS_CONTRACT, GENESIS_FALLBACK_RPC_URL, TRANSFER_LOG_CHUNK_BLOCKS, createGenesisClaimService, loadGenesisClaimConfig, resolveGenesisFallbackProvider, validateChunkLogs } from "./genesis-claim.js";
import { TRANSFER_BATCH_TOPIC, TRANSFER_SINGLE_TOPIC } from "./genesis-claim-ledger.js";
import { createMemoryGenesisClaimReservationStore } from "./genesis-claim-store.js";
import { createMemoryGenesisScanCheckpointStore, validateCheckpoint } from "./genesis-scan-checkpoint-store.js";

// Deterministic, network-free tests of the Genesis getLogs endpoint rotation (primary GENESIS_RPC_URL,
// secondary free endpoint). A fake clock drives every sleep; no RPC is contacted.
const RELEASE = "0x2222222222222222222222222222222222222222";
const SALE = "0x3333333333333333333333333333333333333333";
const CLAIM = "0x4444444444444444444444444444444444444444";
const TEST_SIGNER_KEY = `0x${"11".repeat(32)}`; // test-only key; holds and protects nothing
const NOW = 1_800_000_000;
const ENV = Object.freeze({
  GENESIS_CLAIM_ENABLED: "true",
  RELEASE_NETWORK: "fuji",
  GENESIS_RPC_URL: "https://c-chain.example/rpc",
  GENESIS_DESTINATION_RPC_URL: "https://fuji.example/rpc",
  GENESIS_CLAIM_RELEASE_CONTRACT: RELEASE,
  GENESIS_CLAIM_PRIMARY_SALE: SALE,
  GENESIS_CLAIM_CONTRACT: CLAIM,
  GENESIS_CLAIM_TOKEN_ID: "987654321",
  GENESIS_CLAIM_ALLOCATION: "0",
  GENESIS_PUBLIC_MINT_ALLOCATION: "0",
  GENESIS_CLAIM_START: String(NOW - 60),
  GENESIS_PUBLIC_PRICE_WEI: "250000000000000000",
  GENESIS_CLAIM_SIGNER_PRIVATE_KEY: TEST_SIGNER_KEY,
  GENESIS_CLAIM_SIGNER_ADDRESS: new Wallet(TEST_SIGNER_KEY).address,
});
const A = "0x1111111111111111111111111111111111111111";
const B = "0x6666666666666666666666666666666666666666";
const C = "0x7777777777777777777777777777777777777777";
const ZERO = "0x0000000000000000000000000000000000000000";
const iface = new Interface([
  "function balanceOf(address account,uint256 id) view returns (uint256)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
]);
const httpError = (status, headers = {}) => Object.assign(new Error(`server response ${status}`), { code: "SERVER_ERROR", info: { responseStatus: `${status} Error` }, response: { headers } });

/** A fake C-Chain: one transfer per block; blocks above `reorgAbove` change hash when `fork` is bumped. */
function chain(holdings) {
  const events = [];
  let head = 1_000;
  const mine = (from, to, tokenId, amount = 1n) => { head += 1; events.push({ block: head, from: from.toLowerCase(), to: to.toLowerCase(), id: BigInt(tokenId), amount: BigInt(amount) }); return head; };
  for (const [key, amount] of Object.entries(holdings)) { const [wallet, tokenId] = key.split(":"); mine(ZERO, wallet, tokenId, amount); }
  const balanceAt = (wallet, tokenId, block) => events.filter((e) => e.block <= block && e.id === tokenId).reduce((sum, e) => sum + (e.to === wallet ? e.amount : 0n) - (e.from === wallet ? e.amount : 0n), 0n);
  const c = {
    fork: 0,
    reorgAbove: 0,
    get head() { return head; },
    transfer: (from, to, tokenId, amount) => mine(from, to, tokenId, amount),
    idle(n = 1) { head += n; return head; },
    getNetwork: vi.fn(async () => ({ chainId: BigInt(GENESIS_CHAIN_ID) })),
    getBlockNumber: vi.fn(async () => head),
    getBlock: vi.fn(async (block) => (Number(block) > head ? null : { number: Number(block), hash: id(`block:${Number(block) > c.reorgAbove ? c.fork : 0}:${Number(block)}`) })),
    call: vi.fn(async ({ data, blockTag }) => {
      const [wallet, tokenId] = iface.decodeFunctionData("balanceOf", data);
      return iface.encodeFunctionResult("balanceOf", [balanceAt(wallet.toLowerCase(), BigInt(tokenId), Number(blockTag))]);
    }),
    getLogs: vi.fn(async ({ fromBlock, toBlock }) => {
      if (toBlock - fromBlock + 1 > 100) throw Object.assign(new Error("range"), { error: { code: -32602 } });
      return events.filter((e) => e.block >= fromBlock && e.block <= toBlock).map((e) => ({ ...iface.encodeEventLog("TransferSingle", [e.from, e.from, e.to, e.id, e.amount]), blockNumber: e.block, index: 0, address: GENESIS_CONTRACT }));
    }),
  };
  return c;
}

function worker({ genesis, checkpointStore, reservations, claimed = new Set(), clock = { t: 0 }, logger = { warn: vi.fn() }, ...overrides }) {
  const signTypedData = vi.fn().mockResolvedValue(`0x${"ab".repeat(65)}`);
  const bindingReader = vi.fn().mockResolvedValue(undefined);
  let counter = 1n;
  const sleep = vi.fn(async (ms) => { clock.t += ms; });
  const instance = createGenesisClaimService({
    config: loadGenesisClaimConfig(ENV),
    signer: { signTypedData, address: ENV.GENESIS_CLAIM_SIGNER_ADDRESS },
    genesisProvider: genesis,
    reservationStore: reservations,
    checkpointStore,
    bindingReader,
    claimStateReader: async (wallet) => ({ alreadyClaimed: claimed.has(getAddress(wallet)), claimedSupply: BigInt(claimed.size) }),
    destinationClock: () => NOW,
    clock: () => NOW,
    nonce: () => counter++,
    sleep,
    random: () => 0.5,
    monotonicNow: () => clock.t,
    logger,
    ...overrides,
  });
  return { instance, signTypedData, bindingReader, sleep, logger, clock };
}

/** A cluster: one chain, one reservation ledger, one checkpoint store; `spawn()` starts a fresh worker (a restart). */
function cluster(holdings = { [`${A}:0`]: 1n, [`${B}:1`]: 1n }) {
  const genesis = chain(holdings);
  const reservations = createMemoryGenesisClaimReservationStore();
  const checkpointStore = createMemoryGenesisScanCheckpointStore();
  const claimed = new Set();
  return { genesis, reservations, checkpointStore, claimed, spawn: (extra = {}) => worker({ genesis, checkpointStore, reservations, claimed, ...extra }) };
}
const row = (cl) => cl.checkpointStore.rows.get(CLAIM.toLowerCase());

/** A secondary endpoint mirroring the same fake chain, with its own getLogs/getBlock/send mocks. */
function mirror(genesis, { chainId = GENESIS_CHAIN_ID } = {}) {
  const blocks = genesis.getBlock.getMockImplementation();
  const logs = genesis.getLogs.getMockImplementation();
  return {
    send: vi.fn(async (method) => { if (method !== "eth_chainId") throw new Error("unexpected"); return `0x${chainId.toString(16)}`; }),
    getBlockNumber: vi.fn(async () => genesis.head),
    getBlock: vi.fn(async (block) => blocks(block)),
    call: vi.fn(async (req) => genesis.call(req)),
    getLogs: vi.fn(async (filter) => Promise.all((await logs(filter)).map(async (log) => ({ ...log, blockHash: (await blocks(log.blockNumber)).hash })))),
  };
}
/** Like `seeded` in the checkpoint tests: A holds a voucher, then 5,000 idle blocks (50 chunks). */
async function setup({ chainId, holdings } = {}) {
  const cl = cluster(holdings);
  const fallback = mirror(cl.genesis, { chainId });
  const first = cl.spawn({ genesisFallbackProvider: fallback });
  await first.instance.issueVoucher(A);
  cl.genesis.idle(5_000);
  cl.genesis.getLogs.mockClear(); cl.genesis.getBlock.mockClear();
  return { cl, fallback, first };
}
const filterKey = (f) => JSON.stringify({ address: f.address, topics: f.topics, fromBlock: f.fromBlock, toBlock: f.toBlock });
const resetError = () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
const timeoutError = () => Object.assign(new Error("request timeout"), { code: "TIMEOUT" });

describe("Genesis getLogs endpoint rotation", () => {
  it("the documented secondary is the public, keyless PublicNode C-Chain endpoint (on by default)", () => {
    expect(GENESIS_FALLBACK_RPC_URL).toBe("https://avalanche-c-chain-rpc.publicnode.com");
    expect(TRANSFER_LOG_CHUNK_BLOCKS).toBe(100);
  });

  it("(1) primary succeeds: the fallback is never contacted", async () => {
    const { cl, fallback, first } = await setup();
    await expect(first.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(cl.genesis.getLogs).toHaveBeenCalledTimes(50);
    expect(fallback.send).not.toHaveBeenCalled();
    expect(fallback.getLogs).not.toHaveBeenCalled();
    expect(fallback.getBlock).not.toHaveBeenCalled();
  });

  it("(2)+(7) primary 429 with Retry-After: the same range and filter go to the fallback, which completes", async () => {
    const { cl, fallback, first } = await setup();
    cl.genesis.getLogs.mockRejectedValueOnce(httpError(429, { "retry-after": "3" }));
    await expect(first.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    const failed = cl.genesis.getLogs.mock.calls[0][0];
    expect(filterKey(fallback.getLogs.mock.calls[0][0])).toBe(filterKey(failed));
    expect(failed.topics).toEqual([[TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]]);
    expect(failed.address).toBe(GENESIS_CONTRACT);
    expect(fallback.send).toHaveBeenCalledWith("eth_chainId", []);
    // Both boundary blocks of the range were proven present on the fallback.
    expect(fallback.getBlock.mock.calls.slice(0, 2).map(([b]) => b)).toEqual([failed.fromBlock, failed.toBlock]);
    // While the primary sits in its 3 s Retry-After cooldown the fallback serves the following chunks;
    // after it the primary is used again. Every block range is fetched successfully exactly once.
    const ok = [...cl.genesis.getLogs.mock.calls.slice(1), ...fallback.getLogs.mock.calls].map(([f]) => f.fromBlock).sort((a, b) => a - b);
    expect(new Set(ok).size).toBe(50);
    expect(ok.length).toBe(50);
    expect(cl.genesis.getLogs.mock.calls.length).toBeGreaterThan(1);
    expect(cl.checkpointStore.saves).toBe(1);
  });

  it("Retry-After is honored on the primary when the fallback is unavailable", async () => {
    const cl = cluster();
    const w = cl.spawn({ genesisFallbackProvider: null });
    await w.instance.issueVoucher(A);
    cl.genesis.idle(500);
    cl.genesis.getLogs.mockRejectedValueOnce(httpError(429, { "retry-after": "2" }));
    await expect(w.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(w.sleep.mock.calls.map(([ms]) => ms)).toContain(2_000);
  });

  it.each([
    ["Cloudflare 1015 (HTTP 429)", () => httpError(429)],
    ["HTTP 599", () => httpError(599)],
    ["timeout", timeoutError],
    ["connection reset", resetError],
  ])("(3) primary %s: the fallback completes the chunk", async (_label, makeError) => {
    const { cl, fallback, first } = await setup();
    cl.genesis.getLogs.mockRejectedValueOnce(makeError());
    await expect(first.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(fallback.getLogs).toHaveBeenCalledTimes(1);
    expect(fallback.getLogs.mock.calls[0][0].fromBlock).toBe(cl.genesis.getLogs.mock.calls[0][0].fromBlock);
  });

  it("(4) both endpoints fail: clean 503 with no provider detail, and no voucher", async () => {
    const { cl, fallback, first } = await setup();
    cl.genesis.getLogs.mockRejectedValue(httpError(429, { "retry-after": "1" }));
    fallback.getLogs.mockRejectedValue(httpError(599));
    const error = await first.instance.checkEligibility(B).catch((e) => e);
    expect(error).toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
    expect(String(error.message)).not.toMatch(/pocket|429|599|http/i);
    expect(JSON.stringify(first.logger.warn.mock.calls)).not.toMatch(/pocket|https?:/i);
    // One attempt budget (maxAttempts 5) across both endpoints: no multiplied retries.
    expect(cl.genesis.getLogs.mock.calls.length + fallback.getLogs.mock.calls.length).toBe(5);
    await expect(first.instance.issueVoucher(B)).rejects.toMatchObject({ status: 503 });
    expect(first.signTypedData).toHaveBeenCalledTimes(1); // only A's earlier voucher
  });

  it("(5) fallback 'not found' for old history is never an empty result: retried on the primary", async () => {
    const { cl, fallback, first } = await setup();
    cl.genesis.getLogs.mockRejectedValueOnce(httpError(429));
    fallback.getLogs.mockRejectedValue(Object.assign(new Error("could not coalesce error"), { error: { code: -32000, message: "header not found" } }));
    await expect(first.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    // The failed range was re-read from the primary: same fromBlock twice there.
    const froms = cl.genesis.getLogs.mock.calls.map(([f]) => f.fromBlock);
    expect(froms[0]).toBe(froms[1]);
  });

  it("(5) fallback missing a boundary block (null) fails closed when the primary is also down", async () => {
    const { cl, fallback, first } = await setup();
    cl.genesis.getLogs.mockRejectedValue(httpError(429));
    fallback.getBlock.mockResolvedValue(null);
    await expect(first.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503 });
    expect(fallback.getLogs).not.toHaveBeenCalled();
  });

  it("(6) neither endpoint returns complete results: no partial eligibility, checkpoint unchanged", async () => {
    const { cl, fallback, first } = await setup();
    await first.instance.checkEligibility(B);
    const before = structuredClone(row(cl));
    cl.genesis.idle(1_000);
    const real = cl.genesis.getLogs.getMockImplementation();
    cl.genesis.getLogs.mockImplementation(async (f) => (f.fromBlock > before.checkpoint.end ? [{ bogus: true }] : real(f)));
    fallback.getLogs.mockResolvedValue("not an array");
    await expect(first.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
    expect(row(cl)).toEqual(before);
  });

  it("(8) a fallback on the wrong chain is disabled and never trusted", async () => {
    const { cl, fallback, first } = await setup({ chainId: 1 });
    cl.genesis.getLogs.mockRejectedValueOnce(httpError(429, { "retry-after": "1" }));
    await expect(first.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(fallback.getLogs).not.toHaveBeenCalled();
    expect(fallback.getBlock).not.toHaveBeenCalled();
    cl.genesis.getLogs.mockRejectedValue(httpError(429));
    cl.genesis.idle(200);
    await expect(first.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503 });
    expect(fallback.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another contract", (log) => ({ ...log, address: "0x9999999999999999999999999999999999999999" })],
    ["a block outside the range", (log) => ({ ...log, blockNumber: log.blockNumber + 1_000 })],
    ["a removed (reorged) log", (log) => ({ ...log, removed: true })],
    ["an unrelated topic", (log) => ({ ...log, topics: [id("Other()")] })],
    ["a missing log index", (log) => ({ ...log, index: undefined, logIndex: undefined })],
  ])("(8) a malformed fallback log (%s) is rejected, not processed", async (_label, corrupt) => {
    const { cl, fallback, first } = await setup({ holdings: { [`${A}:0`]: 1n, [`${B}:1`]: 1n } });
    // Make the chunk that holds B's mint fail on the primary.
    cl.genesis.transfer(B, C, 1n); // a real transfer inside the scanned range
    const real = cl.genesis.getLogs.getMockImplementation();
    cl.genesis.getLogs.mockImplementation(async () => { throw httpError(429); });
    fallback.getLogs.mockImplementation(async (f) => (await real(f)).map(corrupt));
    await expect(first.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503 });
  });

  it("(9) duplicate events in one response are rejected; retries never double-count a transfer", async () => {
    expect(() => validateChunkLogs([{ address: GENESIS_CONTRACT, topics: [TRANSFER_SINGLE_TOPIC], data: "0x", blockNumber: 5, index: 0 }, { address: GENESIS_CONTRACT, topics: [TRANSFER_SINGLE_TOPIC], data: "0x", blockNumber: 5, index: 0 }], { fromBlock: 1, toBlock: 10 })).toThrow(/complete/);
    // Every chunk fails once on the primary and is re-read on the fallback: each event is kept once.
    const { cl, fallback, first } = await setup();
    const real = cl.genesis.getLogs.getMockImplementation();
    let n = 0;
    cl.genesis.getLogs.mockImplementation(async (f) => { n += 1; if (n % 2) throw resetError(); return real(f); });
    await expect(first.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true, eligibleTokenIds: ["1"] });
    const saved = row(cl).checkpoint;
    const keys = saved.logs.map((log) => `${log.blockNumber}:${log.index}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(fallback.getLogs.mock.calls.length).toBeGreaterThan(0);
  });

  it("(10)+(11) a failing chunk never advances the checkpoint past it; completed chunks persist and the next run resumes", async () => {
    const { cl, fallback, first } = await setup();
    await first.instance.checkEligibility(B);
    const before = structuredClone(row(cl));
    cl.genesis.idle(1_000);
    const real = cl.genesis.getLogs.getMockImplementation();
    const failFrom = before.checkpoint.end + 1 + 3 * 100; // the 4th new chunk
    const broken = async (f) => { if (f.fromBlock >= failFrom) throw httpError(429); return real(f); };
    cl.genesis.getLogs.mockImplementation(broken);
    fallback.getLogs.mockImplementation(async (f) => { if (f.fromBlock >= failFrom) throw httpError(599); return real(f); });
    await expect(first.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503 });
    const partial = row(cl).checkpoint;
    expect(partial.end).toBe(failFrom - 1);
    expect(partial.end).toBeLessThan(failFrom);
    expect(() => validateCheckpoint(partial, row(cl).digest)).not.toThrow();
    // Next run (restart) resumes exactly after the last persisted chunk.
    cl.genesis.getLogs.mockImplementation(real);
    fallback.getLogs.mockImplementation(real);
    cl.genesis.getLogs.mockClear();
    const restarted = cl.spawn({ genesisFallbackProvider: fallback });
    await expect(restarted.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(cl.genesis.getLogs.mock.calls[0][0].fromBlock).toBe(failFrom);
    expect(row(cl).checkpoint.end).toBe(cl.genesis.head - 32);
  });

  it("(10) a failed fallback cannot overwrite a newer checkpoint written by another worker", async () => {
    const { cl, fallback, first } = await setup();
    await first.instance.checkEligibility(B);
    const other = cl.spawn({ genesisFallbackProvider: null });
    cl.genesis.idle(500);
    await other.instance.checkEligibility(B); // the other worker advances the row
    const newest = structuredClone(row(cl));
    cl.genesis.idle(500);
    cl.genesis.getLogs.mockRejectedValue(httpError(429));
    fallback.getLogs.mockRejectedValue(httpError(599));
    await expect(first.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503 });
    expect(row(cl)).toEqual(newest);
  });

  it("(12) reorg rewind still works when the fallback served the chunks", async () => {
    const { cl, fallback, first } = await setup();
    await first.instance.checkEligibility(B);
    const anchorEnd = row(cl).checkpoint.end;
    cl.genesis.idle(300);
    await first.instance.checkEligibility(B);
    cl.genesis.reorgAbove = anchorEnd;
    cl.genesis.fork = 3;
    cl.genesis.getLogs.mockRejectedValue(httpError(429));
    const restarted = cl.spawn({ genesisFallbackProvider: fallback });
    await expect(restarted.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(restarted.logger.warn).toHaveBeenCalledWith("genesis.scan.checkpoint", { event: "reorg_rewind" });
    expect(fallback.getLogs.mock.calls.at(-1)[0].toBlock).toBe(cl.genesis.head);
    expect(row(cl).checkpoint.endHash).toBe((await cl.genesis.getBlock(row(cl).checkpoint.end)).hash.toLowerCase());
  });

  it("(12) two workers with fallbacks still serialize checkpoint writes by compare-and-set", async () => {
    const { cl, fallback } = await setup();
    const w1 = cl.spawn({ genesisFallbackProvider: fallback });
    const w2 = cl.spawn({ genesisFallbackProvider: mirror(cl.genesis) });
    cl.genesis.getLogs.mockRejectedValueOnce(httpError(429));
    const results = await Promise.all([w1.instance.checkEligibility(B), w2.instance.checkEligibility(B)]);
    expect(results.every((r) => r.eligible)).toBe(true);
    expect(cl.checkpointStore.saves).toBe(1);
    expect(() => validateCheckpoint(row(cl).checkpoint, row(cl).digest)).not.toThrow();
  });

  it("(13) one overall deadline bounds attempts, cooldowns and sleeps under sustained throttling", async () => {
    const { cl, fallback, first } = await setup();
    const start = first.clock.t;
    // Each call also costs 4 s of (fake) in-flight time.
    cl.genesis.getLogs.mockImplementation(async () => { first.clock.t += 4_000; throw httpError(429, { "retry-after": "30" }); });
    fallback.getLogs.mockImplementation(async () => { first.clock.t += 4_000; throw httpError(429, { "retry-after": "30" }); });
    await expect(first.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503 });
    const elapsed = first.clock.t - start;
    // Retry-After is not capped by maxDelayMs (4 s); attempts stop when the 45 s budget cannot fit another wait.
    expect(elapsed).toBeLessThanOrEqual(45_000 + 4_000);
    expect(Math.max(...first.sleep.mock.calls.map(([ms]) => ms))).toBeGreaterThanOrEqual(25_000);
    expect(Math.max(...first.sleep.mock.calls.map(([ms]) => ms))).toBeLessThanOrEqual(30_000);
    expect(cl.genesis.getLogs.mock.calls.length + fallback.getLogs.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("(13) the deadline stops a scan that keeps succeeding slowly, and keeps the verified prefix", async () => {
    const { cl, fallback, first } = await setup();
    const real = cl.genesis.getLogs.getMockImplementation();
    cl.genesis.getLogs.mockImplementation(async (f) => { first.clock.t += 2_000; return real(f); });
    await expect(first.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503 });
    expect(cl.genesis.getLogs.mock.calls.length).toBeLessThan(50);
    expect(fallback.getLogs).not.toHaveBeenCalled();
    const saved = row(cl)?.checkpoint;
    expect(saved).toBeDefined();
    expect(saved.end).toBe(cl.genesis.getLogs.mock.calls.at(-1)[0].toBlock);
  });

  it("(non-transient) invalid params from the primary are not retried or rotated", async () => {
    const { cl, fallback, first } = await setup();
    cl.genesis.getLogs.mockRejectedValueOnce(Object.assign(new Error("invalid params"), { error: { code: -32602 } }));
    await expect(first.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503 });
    expect(cl.genesis.getLogs).toHaveBeenCalledTimes(1);
    expect(fallback.getLogs).not.toHaveBeenCalled();
  });

  it("(regression) injected null disables fallback: a throttled primary fails closed with 503", async () => {
    expect(resolveGenesisFallbackProvider(null)).toBeNull();
    // Default (undefined) constructs the verified PublicNode provider; the URL is not configurable by env.
    const built = resolveGenesisFallbackProvider(undefined);
    expect(built).not.toBeNull();
    expect(typeof built.send).toBe("function");
    expect(GENESIS_FALLBACK_RPC_URL).toBe("https://avalanche-c-chain-rpc.publicnode.com");
    const cl = cluster();
    const w = cl.spawn({ genesisFallbackProvider: null }); // explicitly disable
    await w.instance.issueVoucher(A);
    cl.claimed.add(getAddress(A));
    cl.genesis.idle(500);
    cl.genesis.transfer(A, C, 0n);
    cl.genesis.getLogs.mockRejectedValue(httpError(429));
    await expect(w.instance.checkEligibility(C)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
  });

  it("(regression) missing logs: an empty fallback answer never makes C eligible for A's used unit", async () => {
    const { cl, fallback, first } = await setup();
    cl.claimed.add(getAddress(A));
    cl.genesis.transfer(A, C, 0n); // A's used unit moves to C inside the scanned range
    cl.genesis.getLogs.mockRejectedValue(httpError(429));
    fallback.getLogs.mockResolvedValue([]); // headers present, logs missing
    // The fallback's boundary hashes are on another fork here, so the empty answer is rejected.
    const real = fallback.getBlock.getMockImplementation();
    fallback.getBlock.mockImplementation(async (b) => ({ ...(await real(b)), hash: id(`other:${b}`) }));
    const result = await first.instance.checkEligibility(C).catch((e) => e);
    expect(result).toMatchObject({ status: 503 });
  });

  it("(regression, known limitation) an injected fallback with matching hashes but no logs cannot be proven incomplete", async () => {
    // Documented: the injected path still trusts an empty result when both boundary hashes match the
    // primary. The same limitation applies to the default PublicNode fallback; this test pins the injected path.
    const { cl, fallback, first } = await setup();
    cl.claimed.add(getAddress(A));
    cl.genesis.transfer(A, C, 0n);
    cl.genesis.getLogs.mockRejectedValue(httpError(429));
    fallback.getLogs.mockResolvedValue([]);
    await expect(first.instance.checkEligibility(C)).resolves.toMatchObject({ eligible: true });
  });

  it("(regression) wrong fork: fallback boundary hashes that differ from the primary never produce a successful scan", async () => {
    const { cl, fallback, first } = await setup();
    cl.genesis.getLogs.mockRejectedValue(httpError(429));
    fallback.getBlock.mockImplementation(async (b) => ({ number: Number(b), hash: id(`fork:${b}`) }));
    await expect(first.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503 });
    expect(row(cl)).toBeUndefined();
  });

  it("(regression) wrong fork: a fallback log whose blockHash differs from the primary is rejected", async () => {
    const { cl, fallback, first } = await setup();
    cl.genesis.transfer(A, C, 0n);
    cl.genesis.getLogs.mockRejectedValue(httpError(429));
    const real = fallback.getLogs.getMockImplementation();
    fallback.getLogs.mockImplementation(async (f) => (await real(f)).map((log) => ({ ...log, blockHash: id("fork") })));
    await expect(first.instance.checkEligibility(C)).rejects.toMatchObject({ status: 503 });
  });

  it("(regression) a primary 429 on head falls back to PublicNode and still returns eligibility", async () => {
    const cl = cluster({ [`${B}:1`]: 1n });
    const fallback = mirror(cl.genesis);
    const w = cl.spawn({ genesisFallbackProvider: fallback });
    cl.genesis.getBlockNumber.mockRejectedValue(httpError(429));
    await expect(w.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true, eligibleTokenIds: ["1"] });
    expect(fallback.getBlockNumber).toHaveBeenCalled();
  });

  it("(regression) a primary 429 on balanceOf falls back instead of failing in one round trip", async () => {
    const cl = cluster({ [`${B}:1`]: 1n });
    const realCall = cl.genesis.call.getMockImplementation();
    const fallback = mirror(cl.genesis);
    fallback.call = vi.fn(async (req) => realCall(req));
    const w = cl.spawn({ genesisFallbackProvider: fallback });
    cl.genesis.call.mockRejectedValue(httpError(429));
    await expect(w.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(fallback.call).toHaveBeenCalled();
  });

  it("(regression) HTTP 403 from the fallback excludes that endpoint and does not abort the chunk", async () => {
    const { cl, fallback, first } = await setup();
    cl.genesis.getLogs.mockRejectedValueOnce(httpError(429));
    fallback.getLogs.mockRejectedValueOnce(httpError(403));
    await expect(first.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(fallback.getLogs).toHaveBeenCalled();
    expect(cl.genesis.getLogs.mock.calls.length).toBeGreaterThan(1);
  });
});
