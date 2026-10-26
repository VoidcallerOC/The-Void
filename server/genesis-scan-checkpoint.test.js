import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchRequest, Interface, Wallet, getAddress, id } from "ethers";
import { CONFIG_BINDING_CACHE_MS, GENESIS_CHAIN_ID, GENESIS_CONTRACT, createGenesisClaimService, createGenesisRpcProvider, isRetryableProviderError, loadGenesisClaimConfig, retryAfterMs } from "./genesis-claim.js";
import { createMemoryGenesisClaimReservationStore } from "./genesis-claim-store.js";
import { checkpointDigest, createGenesisScanCheckpointStore, createMemoryGenesisScanCheckpointStore, validateCheckpoint } from "./genesis-scan-checkpoint-store.js";

// Deterministic, network-free tests of the persisted Genesis scan checkpoint, the rate-limit-aware retry
// path and the config-endpoint binding cache. Several services sharing one checkpoint store behave like
// several API workers sharing one database.

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
const D = "0x8888888888888888888888888888888888888888";
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
const reset = (cl) => { cl.genesis.getLogs.mockClear(); cl.genesis.getBlock.mockClear(); };

/** A has issued a voucher (the ledger's first block), then 5,000 idle blocks: a cold scan is 50 chunks. */
async function seeded(holdings) {
  const cl = cluster(holdings);
  const first = cl.spawn();
  await first.instance.issueVoucher(A);
  cl.genesis.idle(5_000);
  reset(cl);
  return { cl, first };
}

describe("persisted Genesis scan checkpoint", () => {
  it("first scan without a checkpoint: scans the whole range and persists a verified checkpoint", async () => {
    const { cl, first } = await seeded();
    expect(row(cl)).toBeUndefined();
    await expect(first.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true, eligibleTokenIds: ["1"] });
    expect(cl.genesis.getLogs).toHaveBeenCalledTimes(50);
    const saved = row(cl).checkpoint;
    expect(saved).toMatchObject({ end: cl.genesis.head - 32, endHash: (await cl.genesis.getBlock(cl.genesis.head - 32)).hash.toLowerCase(), anchors: [] });
    expect(saved.logs.every((log) => log.blockNumber >= saved.from && log.blockNumber <= saved.end)).toBe(true);
    expect(cl.checkpointStore.saves).toBe(1);
  });

  it("cold start (restart) resumes from a valid checkpoint: re-verifies its hash and scans only new blocks", async () => {
    const { cl, first } = await seeded();
    await first.instance.checkEligibility(B);
    const savedEnd = row(cl).checkpoint.end;
    cl.genesis.idle(10);
    reset(cl);
    const restarted = cl.spawn();
    await expect(restarted.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(cl.genesis.getLogs).toHaveBeenCalledTimes(1);
    expect(cl.genesis.getLogs.mock.calls[0][0]).toMatchObject({ fromBlock: savedEnd + 1, toBlock: cl.genesis.head });
    expect(cl.genesis.getBlock.mock.calls.map(([b]) => b)).toEqual([savedEnd, cl.genesis.head - 32]);
    expect(row(cl).checkpoint).toMatchObject({ end: cl.genesis.head - 32, anchors: [{ block: savedEnd }] });
  });

  it("honors Retry-After on a 429 and then advances the checkpoint", async () => {
    const { cl, first } = await seeded();
    cl.genesis.getLogs.mockRejectedValueOnce(httpError(429, { "retry-after": "2" }));
    await expect(first.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(first.sleep.mock.calls.map(([ms]) => ms)).toContain(2_000);
    expect(cl.checkpointStore.saves).toBe(1);
  });

  it("retry exhaustion returns 503 and leaves the persisted checkpoint exactly as it was", async () => {
    const { cl, first } = await seeded();
    await first.instance.checkEligibility(B);
    const before = structuredClone(row(cl));
    cl.genesis.idle(1_000);
    cl.genesis.getLogs.mockRejectedValue(httpError(429, { "retry-after": "1" }));
    const restarted = cl.spawn();
    await expect(restarted.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
    await expect(restarted.instance.issueVoucher(B)).rejects.toMatchObject({ status: 503 });
    expect(restarted.signTypedData).not.toHaveBeenCalled();
    expect(row(cl)).toEqual(before);
  });

  it("an interrupted batch mid-range never advances the checkpoint; the retry resumes from the old one", async () => {
    const { cl, first } = await seeded();
    await first.instance.checkEligibility(B);
    const before = structuredClone(row(cl));
    cl.genesis.idle(3_000);
    const real = cl.genesis.getLogs.getMockImplementation();
    let calls = 0;
    cl.genesis.getLogs.mockImplementation(async (filter) => { calls += 1; if (calls === 15) throw new Error("connection dropped"); return real(filter); });
    const restarted = cl.spawn();
    await expect(restarted.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503 });
    expect(row(cl)).toEqual(before);
    cl.genesis.getLogs.mockImplementation(real);
    reset(cl);
    await expect(restarted.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(cl.genesis.getLogs.mock.calls[0][0].fromBlock).toBe(before.checkpoint.end + 1);
  });

  it("a failed (rolled back) checkpoint write keeps the correct answer and the old row; the next scan persists", async () => {
    const { cl, first } = await seeded();
    await first.instance.checkEligibility(B);
    const before = structuredClone(row(cl));
    cl.genesis.idle(500);
    cl.checkpointStore.failNextSave = new Error("db write failed");
    await expect(first.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(row(cl)).toEqual(before);
    expect(first.logger.warn).toHaveBeenCalledWith("genesis.scan.checkpoint", { event: "save_failed" });
    cl.genesis.idle(5);
    await first.instance.checkEligibility(B);
    expect(row(cl).checkpoint.end).toBe(cl.genesis.head - 32);
  });

  it("a checkpoint store that cannot be read falls back to a full scan and writes nothing", async () => {
    const { cl } = await seeded();
    const broken = { load: vi.fn().mockRejectedValue(new Error("db down")), save: vi.fn(), discard: vi.fn() };
    const w = worker({ genesis: cl.genesis, reservations: cl.reservations, checkpointStore: broken });
    await expect(w.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(cl.genesis.getLogs).toHaveBeenCalledTimes(50);
    expect(broken.save).not.toHaveBeenCalled();
  });

  it.each([
    ["digest mismatch", (r) => { r.digest = "0".repeat(64); }],
    ["log outside the range", (r) => { r.checkpoint.logs.push({ ...r.checkpoint.logs[0], blockNumber: r.checkpoint.end + 1 }); r.digest = checkpointDigest(r.checkpoint); }],
    ["log that is not a Genesis transfer", (r) => { r.checkpoint.logs[0] = { ...r.checkpoint.logs[0], topics: [id("Other()")] }; r.digest = checkpointDigest(r.checkpoint); }],
    ["tampered end block (stale digest)", (r) => { r.checkpoint.end += 1; }],
  ])("a corrupt checkpoint (%s) is discarded and never trusted: full rescan, correct result", async (_label, corrupt) => {
    const { cl, first } = await seeded();
    await first.instance.checkEligibility(B);
    corrupt(row(cl));
    reset(cl);
    const restarted = cl.spawn();
    cl.claimed.add(getAddress(A));
    cl.genesis.transfer(A, C, 0n); // the used unit moves to C: only a complete history knows it
    await expect(restarted.instance.checkEligibility(C)).resolves.toMatchObject({ eligible: false, holdingUsed: true });
    expect(cl.genesis.getLogs.mock.calls.length).toBeGreaterThanOrEqual(50);
    expect(restarted.logger.warn).toHaveBeenCalledWith("genesis.scan.checkpoint", { event: "corrupt_discarded" });
    expect(() => validateCheckpoint(row(cl).checkpoint, row(cl).digest)).not.toThrow();
  });

  it("block-hash mismatch with no surviving anchor (deep reorg) rescans from the start", async () => {
    const { cl, first } = await seeded();
    await first.instance.checkEligibility(B);
    cl.genesis.fork = 1; // every block hash changes
    reset(cl);
    const restarted = cl.spawn();
    await expect(restarted.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(cl.genesis.getLogs).toHaveBeenCalledTimes(50);
    expect(restarted.logger.warn).toHaveBeenCalledWith("genesis.scan.checkpoint", { event: "reorg_rescan" });
    expect(row(cl).checkpoint.endHash).toBe((await cl.genesis.getBlock(row(cl).checkpoint.end)).hash.toLowerCase());
  });

  it("reorg recovery: rewinds to the newest anchor that is still canonical and rescans only after it", async () => {
    const { cl, first } = await seeded();
    await first.instance.checkEligibility(B); // checkpoint 1
    const anchorEnd = row(cl).checkpoint.end;
    cl.genesis.idle(300);
    await first.instance.checkEligibility(B); // checkpoint 2, anchor = checkpoint 1
    expect(row(cl).checkpoint.anchors).toEqual([expect.objectContaining({ block: anchorEnd })]);
    cl.genesis.reorgAbove = anchorEnd; // blocks after the anchor are replaced
    cl.genesis.fork = 7;
    reset(cl);
    const restarted = cl.spawn();
    await expect(restarted.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(restarted.logger.warn).toHaveBeenCalledWith("genesis.scan.checkpoint", { event: "reorg_rewind" });
    expect(cl.genesis.getLogs.mock.calls[0][0].fromBlock).toBe(anchorEnd + 1);
    expect(cl.genesis.getLogs.mock.calls.length).toBeLessThanOrEqual(4);
    expect(row(cl).checkpoint.endHash).toBe((await cl.genesis.getBlock(row(cl).checkpoint.end)).hash.toLowerCase());
  });

  it("concurrent requests in one process share one scan and write the checkpoint once", async () => {
    const { cl, first } = await seeded();
    const results = await Promise.all([B, B, C, D].map((wallet) => first.instance.checkEligibility(wallet)));
    expect(results.map((r) => r.eligible)).toEqual([true, true, false, false]);
    expect(cl.genesis.getLogs.mock.calls.length).toBeLessThanOrEqual(52);
    expect(cl.checkpointStore.saves).toBe(1);
  });

  it("two workers scanning at once cannot double-advance or corrupt the checkpoint (compare-and-set)", async () => {
    const { cl } = await seeded();
    const w1 = cl.spawn();
    const w2 = cl.spawn();
    const results = await Promise.all([w1.instance.checkEligibility(B), w2.instance.checkEligibility(B)]);
    expect(results.every((r) => r.eligible)).toBe(true);
    expect(cl.checkpointStore.saves).toBe(1);
    expect([...w1.logger.warn.mock.calls, ...w2.logger.warn.mock.calls]).toEqual([["genesis.scan.checkpoint", { event: "save_conflict" }]]);
    expect(() => validateCheckpoint(row(cl).checkpoint, row(cl).digest)).not.toThrow();
    // The loser re-reads the row and keeps advancing it from there.
    cl.genesis.idle(10);
    const loser = w1.logger.warn.mock.calls.length ? w1 : w2;
    await loser.instance.checkEligibility(B);
    expect(cl.checkpointStore.saves).toBe(2);
    expect(row(cl).checkpoint.end).toBe(cl.genesis.head - 32);
  });

  it("a stale worker never overwrites a newer checkpoint written by another worker", async () => {
    const { cl } = await seeded();
    const w1 = cl.spawn();
    const w2 = cl.spawn();
    await w1.instance.checkEligibility(B);
    await w2.instance.checkEligibility(B); // w2 adopts w1's row
    cl.genesis.idle(200);
    await w2.instance.checkEligibility(B); // w2 advances
    const newest = structuredClone(row(cl));
    cl.genesis.idle(1);
    await w1.instance.checkEligibility(B); // w1's base is stale: conflict, no overwrite
    expect(row(cl).checkpoint.end).toBeGreaterThanOrEqual(newest.checkpoint.end);
    expect(() => validateCheckpoint(row(cl).checkpoint, row(cl).digest)).not.toThrow();
  });
});

describe("eligibility on a resumed checkpoint", () => {
  it("eligible, ineligible, transferred-away and consumed units are judged the same as a full scan", async () => {
    const { cl, first } = await seeded({ [`${A}:0`]: 1n, [`${B}:1`]: 1n, [`${C}:2`]: 1n });
    await first.instance.checkEligibility(B); // checkpoint persisted
    cl.claimed.add(getAddress(A));
    cl.genesis.transfer(A, D, 0n); // A's consumed unit moves to D
    cl.genesis.transfer(C, D, 2n); // C's unused unit moves to D
    cl.genesis.idle(40); // both transfers are now inside the next checkpoint
    const restarted = cl.spawn();
    await expect(restarted.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true, eligibleTokenIds: ["1"] });
    await expect(restarted.instance.checkEligibility(C)).resolves.toMatchObject({ eligible: false, holdingUsed: false }); // transferred away
    await expect(restarted.instance.checkEligibility(D)).resolves.toMatchObject({ eligible: true, eligibleTokenIds: ["2"] }); // consumed 0 does not count
    await expect(restarted.instance.checkEligibility("0x9999999999999999999999999999999999999999")).resolves.toMatchObject({ eligible: false });
    const again = cl.spawn();
    await expect(again.instance.issueVoucher(D)).resolves.toMatchObject({ voucher: { claimant: getAddress(D) } });
    await expect(again.instance.issueVoucher(A)).rejects.toMatchObject({ status: 409, code: "ALREADY_CLAIMED" });
    await expect(again.instance.issueVoucher(C)).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
  });

  it("no voucher is ever issued from an incomplete scan", async () => {
    const { cl, first } = await seeded({ [`${A}:0`]: 1n, [`${B}:1`]: 1n });
    await first.instance.checkEligibility(B);
    cl.genesis.idle(2_000);
    const real = cl.genesis.getLogs.getMockImplementation();
    let calls = 0;
    cl.genesis.getLogs.mockImplementation(async (filter) => { calls += 1; if (calls > 3) throw httpError(429); return real(filter); });
    const restarted = cl.spawn();
    const ledgerBefore = [...cl.reservations.rows.values()];
    await expect(restarted.instance.issueVoucher(B)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
    expect(restarted.signTypedData).not.toHaveBeenCalled();
    expect([...cl.reservations.rows.values()]).toEqual(ledgerBefore);
  });
});

describe("Postgres checkpoint store transaction handling (scripted client)", () => {
  function scriptedPool({ rows = [], failOn = null } = {}) {
    const queries = [];
    const client = {
      query: vi.fn(async (sql) => {
        queries.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
        if (failOn && sql.includes(failOn)) throw new Error("write failed");
        if (sql.includes("FOR UPDATE")) return { rows };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    return { pool: { connect: vi.fn(async () => client), query: vi.fn() }, client, queries };
  }
  const next = { from: 10, end: 20, endHash: `0x${"aa".repeat(32)}`, anchors: [], logs: [] };

  it("writes under an advisory lock in one transaction", async () => {
    const { pool, queries, client } = scriptedPool();
    await expect(createGenesisScanCheckpointStore(pool).save(CLAIM, null, next)).resolves.toBe(true);
    expect(queries).toEqual(["BEGIN", "SELECT pg_advisory_xact_lock(hashtext($1))", "SELECT end_block,", "INSERT INTO", "COMMIT"]);
    expect(client.release).toHaveBeenCalled();
  });

  it("rolls back and rethrows when the write fails; the client is released", async () => {
    const { pool, queries, client } = scriptedPool({ failOn: "INSERT INTO" });
    await expect(createGenesisScanCheckpointStore(pool).save(CLAIM, null, next)).rejects.toThrow("write failed");
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });

  it("refuses (compare-and-set) when the stored row is not the expected one", async () => {
    const { pool, queries } = scriptedPool({ rows: [{ end_block: "30", end_hash: `0x${"bb".repeat(32)}` }] });
    await expect(createGenesisScanCheckpointStore(pool).save(CLAIM, { end: 20, endHash: `0x${"aa".repeat(32)}` }, { ...next, end: 40 })).resolves.toBe(false);
    expect(queries).not.toContain("INSERT INTO");
    expect(queries.at(-1)).toBe("ROLLBACK");
  });

  it("load reports a row whose digest does not match as corrupt", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{ from_block: "10", end_block: "20", end_hash: next.endHash, anchors: [], logs: [], digest: "0".repeat(64) }] })) };
    await expect(createGenesisScanCheckpointStore(pool).load(CLAIM)).rejects.toMatchObject({ name: "GenesisCheckpointCorruptError" });
  });
});

describe("Genesis RPC provider: ethers' internal retries are off; our backoff sees 429 and Retry-After", () => {
  afterEach(() => { FetchRequest.registerGetUrl(FetchRequest.createGetUrlFunc()); });

  it("a 429 reaches the caller after exactly one HTTP request, with Retry-After readable and retryable", async () => {
    const getUrl = vi.fn(async () => ({ statusCode: 429, statusMessage: "Too Many Requests", headers: { "Retry-After": "3" }, body: new Uint8Array() }));
    FetchRequest.registerGetUrl(getUrl);
    const provider = createGenesisRpcProvider("https://c-chain.example/rpc");
    const error = await provider.getBlockNumber().catch((e) => e);
    expect(getUrl).toHaveBeenCalledTimes(1);
    expect(error.code).toBe("SERVER_ERROR");
    expect(isRetryableProviderError(error)).toBe(true);
    expect(retryAfterMs(error)).toBe(3_000);
    provider.destroy();
  });

  it("sends one JSON-RPC call per request (no batching) and needs no eth_chainId per call", async () => {
    const bodies = [];
    FetchRequest.registerGetUrl(async (req) => {
      const payload = JSON.parse(new TextDecoder().decode(req.body));
      bodies.push(payload);
      return { statusCode: 200, statusMessage: "OK", headers: { "content-type": "application/json" }, body: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: "0x10" })) };
    });
    const provider = createGenesisRpcProvider("https://c-chain.example/rpc");
    await Promise.all([provider.getBlockNumber(), provider.getBlockNumber()]);
    expect(bodies.every((body) => !Array.isArray(body))).toBe(true);
    expect(bodies.map((body) => body.method)).not.toContain("eth_chainId");
    provider.destroy();
  });
});

describe("/api/claims/config binding cache", () => {
  it("reuses a successful verification for 30 s, never caches a failure, and never applies to vouchers", async () => {
    const cl = cluster();
    const w = cl.spawn();
    await w.instance.verifyConfigBindings();
    await Promise.all([w.instance.verifyConfigBindings(), w.instance.verifyConfigBindings()]);
    expect(w.bindingReader).toHaveBeenCalledTimes(1);
    w.clock.t += CONFIG_BINDING_CACHE_MS;
    w.bindingReader.mockRejectedValueOnce(new Error("rpc down"));
    await expect(w.instance.verifyConfigBindings()).rejects.toThrow("rpc down");
    await w.instance.verifyConfigBindings();
    expect(w.bindingReader).toHaveBeenCalledTimes(3);
    await w.instance.issueVoucher(A);
    await w.instance.issueVoucher(A);
    expect(w.bindingReader).toHaveBeenCalledTimes(5);
  });
});
