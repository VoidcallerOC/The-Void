import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { Interface, Wallet, getAddress, id, verifyTypedData } from "ethers";
import { ApiError } from "./api-errors.js";
import { createApiHandler } from "./api-http.js";
import {
  createGenesisClaimService,
  ELIGIBILITY_RULE,
  ELIGIBILITY_RULE_TEXT,
  GENESIS_CONTRACT,
  GENESIS_CHAIN_ID,
  LEGACY_FUJI_SINGLETON,
  checkGenesisSignerConfig,
  loadGenesisClaimConfig,
  reconcileGenesisReservations,
  scanOptions,
} from "./genesis-claim.js";
import { createMemoryGenesisClaimReservationStore } from "./genesis-claim-store.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const RELEASE = "0x2222222222222222222222222222222222222222";
const SALE = "0x3333333333333333333333333333333333333333";
const CLAIM = "0x4444444444444444444444444444444444444444";
const SIGNER = "0x5555555555555555555555555555555555555555";
// Test-only key; it holds nothing and protects nothing.
const TEST_SIGNER_KEY = `0x${"11".repeat(32)}`;
const TEST_SIGNATURE = `0x${"ab".repeat(65)}`;
const NOW = 1_800_000_000;
const CLAIM_START = NOW - 60;
const CLAIM_END = CLAIM_START + 86_400;
// The paid sale opens with the claims; its inclusive end gives exactly seven days.
const PUBLIC_END = CLAIM_START + 7 * 86_400 - 1;
const PRICE = 250_000_000_000_000_000n; // 0.25 AVAX
const ISSUER_ROLE = id("ISSUER_ROLE");

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
  GENESIS_CLAIM_START: String(CLAIM_START),
  GENESIS_PUBLIC_PRICE_WEI: PRICE.toString(),
  GENESIS_CLAIM_SIGNER_PRIVATE_KEY: TEST_SIGNER_KEY,
  GENESIS_CLAIM_SIGNER_ADDRESS: new Wallet(TEST_SIGNER_KEY).address,
});

const genesisIface = new Interface([
  "function balanceOf(address account,uint256 id) view returns (uint256)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
]);
const ZERO = "0x0000000000000000000000000000000000000000";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x6666666666666666666666666666666666666666";
const C = "0x7777777777777777777777777777777777777777";
const D = "0x8888888888888888888888888888888888888888";

/**
 * A simulated C-Chain Genesis collection. Every mint or transfer is mined in its own block and emits the
 * real ERC-1155 TransferSingle/TransferBatch log; balanceOf honours the block tag.
 */
function genesisChain(holdings = {}, { chainId = GENESIS_CHAIN_ID } = {}) {
  const events = [];
  let head = 1_000;
  const calls = [];
  const balanceAt = (wallet, id, block) => events.filter((event) => event.block <= block).reduce((sum, event) => sum
    + event.pairs.reduce((acc, [eid, amount]) => acc + (eid === id ? (event.to === wallet ? amount : 0n) - (event.from === wallet ? amount : 0n) : 0n), 0n), 0n);
  const mine = (from, to, pairs, batch = false) => {
    head += 1;
    events.push({ block: head, from: from.toLowerCase(), to: to.toLowerCase(), pairs: pairs.map(([id, amount]) => [BigInt(id), BigInt(amount)]), batch });
    return head;
  };
  for (const [key, amount] of Object.entries(holdings)) {
    const [wallet, id] = key.split(":");
    mine(ZERO, wallet, [[id, amount]]);
  }
  const chain = {
    calls,
    get head() { return head; },
    balanceAt: (wallet, id, block) => balanceAt(wallet.toLowerCase(), BigInt(id), block),
    transfer: (from, to, id, amount = 1n) => mine(from, to, [[id, amount]]),
    batchTransfer: (from, to, pairs) => mine(from, to, pairs, true),
    idle: () => { head += 1; return head; },
    getNetwork: vi.fn(async () => ({ chainId: BigInt(chainId) })),
    getBlockNumber: vi.fn(async () => head),
    // Deterministic block hashes; bumping `fork` simulates a reorg that changes every hash.
    fork: 0,
    getBlock: vi.fn(async (block) => (Number(block) > head ? null : { number: Number(block), hash: id(`block:${chain.fork}:${Number(block)}`) })),
    call: vi.fn(async ({ to, data, blockTag }) => {
      calls.push({ to, blockTag });
      const [wallet, tokenId] = genesisIface.decodeFunctionData("balanceOf", data);
      const block = blockTag === "latest" ? head : Number(blockTag);
      return genesisIface.encodeFunctionResult("balanceOf", [balanceAt(wallet.toLowerCase(), BigInt(tokenId), block)]);
    }),
    getLogs: vi.fn(async ({ address, fromBlock, toBlock }) => {
      expect(getAddress(address)).toBe(GENESIS_CONTRACT);
      return events.filter((event) => event.block >= fromBlock && event.block <= toBlock).map((event) => {
        const encoded = event.batch
          ? genesisIface.encodeEventLog("TransferBatch", [event.from, event.from, event.to, event.pairs.map(([id]) => id), event.pairs.map(([, amount]) => amount)])
          : genesisIface.encodeEventLog("TransferSingle", [event.from, event.from, event.to, event.pairs[0][0], event.pairs[0][1]]);
        return { ...encoded, blockNumber: event.block, index: 0, address: GENESIS_CONTRACT };
      });
    }),
  };
  return chain;
}

/** Destination-chain claim state: which wallets redeemed, claimed supply, and chain time. */
function destination({ now = NOW, claimedSupply = 0n, claimed = [] } = {}) {
  const state = { now, claimedSupply, claimed: new Set(claimed.map((wallet) => getAddress(wallet))) };
  return {
    state,
    redeem(wallet) { state.claimed.add(getAddress(wallet)); state.claimedSupply += 1n; },
    claimStateReader: vi.fn(async (wallet) => ({ alreadyClaimed: state.claimed.has(getAddress(wallet)), claimedSupply: state.claimedSupply })),
    destinationClock: () => state.now,
  };
}

function service({ holdings = { [`${WALLET}:0`]: 1n }, alreadyClaimed = false, claimedSupply = 0n, env = {}, clock = NOW, chain = null, dest = null, store = null, ...overrides } = {}) {
  const signTypedData = vi.fn().mockResolvedValue(TEST_SIGNATURE);
  const bindingReader = vi.fn().mockResolvedValue(undefined);
  const genesis = chain || genesisChain(holdings);
  const target = dest || destination({ claimedSupply, claimed: alreadyClaimed ? [WALLET] : [] });
  const reservations = store || createMemoryGenesisClaimReservationStore();
  let counter = 987654321n;
  const instance = createGenesisClaimService({
    config: loadGenesisClaimConfig({ ...ENV, ...env }),
    signer: { signTypedData, address: SIGNER },
    genesisProvider: genesis,
    reservationStore: reservations,
    bindingReader,
    claimStateReader: target.claimStateReader,
    destinationClock: target.destinationClock,
    clock: () => clock,
    nonce: () => counter++,
    sleep: async () => {},
    random: () => 0.5,
    ...overrides,
  });
  return { instance, signTypedData, bindingReader, claimStateReader: target.claimStateReader, chain: genesis, dest: target, store: reservations };
}

describe("Genesis eligibility from live C-Chain ownership", () => {
  it.each([0, 1, 2, 3])("accepts a wallet that currently holds Genesis token %i, read at the current head", async (tokenId) => {
    const chain = genesisChain({ [`${WALLET}:${tokenId}`]: 1n });
    const { instance } = service({ chain });
    await expect(instance.checkEligibility(WALLET)).resolves.toMatchObject({ eligible: true, eligibleTokenIds: [String(tokenId)], holdingUsed: false });
    expect(chain.calls).toHaveLength(4);
    expect(chain.calls.every((call) => call.blockTag === chain.head && call.to === GENESIS_CONTRACT)).toBe(true);
  });

  it("denies a wallet that holds no Genesis token now", async () => {
    const { instance, signTypedData } = service({ holdings: {} });
    await expect(instance.checkEligibility(WALLET)).resolves.toMatchObject({ eligible: false, eligibleTokenIds: [], holdingUsed: false });
    await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("fails closed on a provider that is not C-Chain, or on a failed or malformed read", async () => {
    const holder = { [`${WALLET}:0`]: 1n };
    const failing = { ...genesisChain(holder), call: vi.fn().mockRejectedValue(new Error("rpc offline")) };
    const malformed = { ...genesisChain(holder), call: vi.fn().mockResolvedValue("0x") };
    const noHead = { ...genesisChain(holder), getBlockNumber: vi.fn().mockRejectedValue(new Error("rpc offline")) };
    for (const chain of [genesisChain(holder, { chainId: 43113 }), failing, malformed, noHead]) {
      const { instance, signTypedData } = service({ chain });
      await expect(instance.checkEligibility(WALLET)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
      await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
      expect(signTypedData).not.toHaveBeenCalled();
    }
  });

  it("names the contract's rule and needs no snapshot configuration", () => {
    expect(ELIGIBILITY_RULE_TEXT).toBe("the-void:genesis-eligibility:v3:live-balanceOf(wallet,0..3)-minus-units-used-by-earlier-claims>0;used-units-follow-transfers");
    expect(ELIGIBILITY_RULE).toBe(id(ELIGIBILITY_RULE_TEXT));
    expect(loadGenesisClaimConfig(ENV)).not.toHaveProperty("snapshotBlock");
  });

  it("refuses to run without the reservation store", () => {
    expect(() => createGenesisClaimService({ config: loadGenesisClaimConfig(ENV), signer: { address: SIGNER } })).toThrow(/reservation store/);
  });
});

describe("Genesis holding cannot be reused across wallets (adversarial)", () => {
  it("denies the next wallet when a claimed single unit is resold, and the one after it", async () => {
    const { instance, chain, dest } = service({ holdings: { [`${A}:1`]: 1n } });
    await expect(instance.issueVoucher(A)).resolves.toMatchObject({ voucher: { claimant: getAddress(A) } });
    dest.redeem(A);
    chain.transfer(A, B, 1n);
    await expect(instance.checkEligibility(B)).resolves.toMatchObject({ eligible: false, holdingUsed: true });
    await expect(instance.issueVoucher(B)).rejects.toMatchObject({ status: 403, code: "GENESIS_HOLDING_ALREADY_USED" });
    chain.transfer(B, C, 1n);
    await expect(instance.issueVoucher(C)).rejects.toMatchObject({ status: 403, code: "GENESIS_HOLDING_ALREADY_USED" });
  });

  it("denies the receiver while the sender's voucher is issued but not yet redeemed", async () => {
    const { instance, chain } = service({ holdings: { [`${A}:3`]: 1n } });
    await instance.issueVoucher(A);
    chain.transfer(A, B, 3n);
    await expect(instance.issueVoucher(B)).rejects.toMatchObject({ status: 403, code: "GENESIS_HOLDING_ALREADY_USED" });
  });

  it("serializes simultaneous requests: a holding passed on mid-issuance backs only the first voucher", async () => {
    const chain = genesisChain({ [`${A}:0`]: 1n });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let readStarted;
    const started = new Promise((resolve) => { readStarted = resolve; });
    const balanceReader = async (wallet, block) => {
      if (getAddress(wallet) === getAddress(A)) { readStarted(); await gate; }
      return Object.fromEntries(["0", "1", "2", "3"].map((tokenId) => [tokenId, chain.balanceAt(wallet, tokenId, block)]));
    };
    const { instance } = service({ chain, balanceReader });
    const first = instance.issueVoucher(A);
    await started;
    chain.transfer(A, B, 0n);
    const second = instance.issueVoucher(B);
    release();
    await expect(first).resolves.toMatchObject({ voucher: { claimant: getAddress(A) } });
    await expect(second).rejects.toMatchObject({ status: 403, code: "GENESIS_HOLDING_ALREADY_USED" });
  });

  it("uses exactly one unit of a multi-unit, multi-ID holding; the wallet's other units still qualify new holders", async () => {
    const { instance, chain, dest, store } = service({ holdings: { [`${A}:0`]: 4n, [`${A}:1`]: 2n, [`${A}:3`]: 21n } });
    await expect(instance.checkEligibility(A)).resolves.toMatchObject({ eligible: true, eligibleTokenIds: ["0", "1", "3"] });
    const issued = await instance.issueVoucher(A);
    expect(issued.voucher.quantity).toBe("1");
    expect([...store.rows.values()][0]).toMatchObject({ usedTokenId: "0", balances: { 0: "4", 1: "2", 2: "0", 3: "21" } });
    dest.redeem(A);
    // Resale of the used unit: the first ID-0 unit to leave A is the used one.
    chain.transfer(A, B, 0n, 1n);
    await expect(instance.issueVoucher(B)).rejects.toMatchObject({ status: 403, code: "GENESIS_HOLDING_ALREADY_USED" });
    // Resale of an unused unit of the same ID, and a batch of unused units of other IDs.
    chain.transfer(A, C, 0n, 1n);
    chain.batchTransfer(A, D, [[1n, 2n], [3n, 10n]]);
    await expect(instance.issueVoucher(C)).resolves.toMatchObject({ voucher: { claimant: getAddress(C) } });
    await expect(instance.issueVoucher(D)).resolves.toMatchObject({ voucher: { claimant: getAddress(D) } });
    await expect(instance.issueVoucher(A)).rejects.toMatchObject({ status: 409, code: "ALREADY_CLAIMED" });
  });

  it("carries the used unit inside a batch: the receiver keeps eligibility from the unused units in it", async () => {
    const { instance, chain, dest } = service({ holdings: { [`${A}:2`]: 3n } });
    await instance.issueVoucher(A);
    dest.redeem(A);
    chain.batchTransfer(A, B, [[2n, 3n]]);
    await expect(instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true, eligibleTokenIds: ["2"] });
    const second = await instance.issueVoucher(B);
    dest.redeem(B);
    chain.transfer(B, C, 2n, 2n);
    await expect(instance.issueVoucher(C)).rejects.toMatchObject({ code: "GENESIS_HOLDING_ALREADY_USED" });
    chain.transfer(B, D, 2n, 1n);
    await expect(instance.issueVoucher(D)).resolves.toMatchObject({ voucher: { claimant: getAddress(D) } });
    expect(second.voucher.quantity).toBe("1");
  });

  it("skips a used unit the wallet received and uses one of its own unused units", async () => {
    const { instance, chain, dest, store } = service({ holdings: { [`${A}:0`]: 1n, [`${B}:3`]: 1n } });
    await instance.issueVoucher(A);
    dest.redeem(A);
    chain.transfer(A, B, 0n);
    await instance.issueVoucher(B);
    expect(store.rows.get(`${CLAIM.toLowerCase()}:${B.toLowerCase()}`)).toMatchObject({ usedTokenId: "3" });
    dest.redeem(B);
    chain.transfer(B, C, 3n);
    chain.transfer(B, D, 0n);
    for (const wallet of [C, D]) await expect(instance.issueVoucher(wallet)).rejects.toMatchObject({ code: "GENESIS_HOLDING_ALREADY_USED" });
  });

  it("lets independent holders claim concurrently without blocking each other", async () => {
    const { instance } = service({ holdings: { [`${A}:0`]: 1n, [`${B}:1`]: 1n, [`${C}:3`]: 2n } });
    const results = await Promise.all([A, B, C].map((wallet) => instance.issueVoucher(wallet)));
    expect(results.map((result) => result.voucher.claimant)).toEqual([A, B, C].map((wallet) => getAddress(wallet)));
    expect(new Set(results.map((result) => result.voucher.nonce)).size).toBe(3);
  });

  it("only reads Genesis: balanceOf calls, logs, head and network; never a write, approval or transaction", async () => {
    const chain = genesisChain({ [`${A}:0`]: 2n, [`${B}:1`]: 1n });
    const methods = new Set();
    const spy = new Proxy(chain, { get(target, property) { if (typeof target[property] === "function") methods.add(String(property)); return target[property]; } });
    const { instance, dest } = service({ chain: spy });
    const before = [0, 1, 2, 3].map((tokenId) => [chain.balanceAt(A, tokenId, chain.head), chain.balanceAt(B, tokenId, chain.head)]);
    await instance.issueVoucher(A);
    dest.redeem(A);
    chain.transfer(A, B, 0n);
    await instance.issueVoucher(B);
    await instance.checkEligibility(A);
    expect([...methods].sort()).toEqual(["call", "getBlockNumber", "getLogs", "getNetwork"]);
    const balanceOf = genesisIface.getFunction("balanceOf").selector;
    expect(chain.call.mock.calls.every(([request]) => request.data.startsWith(balanceOf) && getAddress(request.to) === GENESIS_CONTRACT)).toBe(true);
    // The ledger never touches balances: claims left them as they were; only the user's own transfer moved a unit.
    expect([0, 1, 2, 3].map((tokenId) => chain.balanceAt(A, tokenId, chain.head) + chain.balanceAt(B, tokenId, chain.head)))
      .toEqual(before.map(([a, b]) => a + b));
  });

  it("returns the same voucher to a repeat request, and refuses the wallet once it has claimed", async () => {
    const { instance, dest, signTypedData } = service({ holdings: { [`${A}:2`]: 1n } });
    const first = await instance.issueVoucher(A);
    const again = await instance.issueVoucher(A);
    expect(again.voucher).toEqual(first.voucher);
    expect(again.signature).toBe(first.signature);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    dest.redeem(A);
    await expect(instance.issueVoucher(A)).rejects.toMatchObject({ status: 409, code: "ALREADY_CLAIMED" });
  });

  it("keeps independent holders eligible, including one that also received a used unit", async () => {
    const { instance, chain, dest } = service({ holdings: { [`${A}:1`]: 1n, [`${B}:1`]: 1n, [`${C}:0`]: 2n } });
    await instance.issueVoucher(A);
    dest.redeem(A);
    chain.transfer(A, B, 1n);
    await expect(instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true, eligibleTokenIds: ["1"] });
    await expect(instance.issueVoucher(B)).resolves.toMatchObject({ voucher: { claimant: getAddress(B) } });
    await expect(instance.issueVoucher(C)).resolves.toMatchObject({ voucher: { claimant: getAddress(C) } });
  });

  it("moves used units first: a buyer from a claimed wallet gets a used unit, a later buyer of fresh units does not", async () => {
    const { instance, chain, dest } = service({ holdings: { [`${A}:3`]: 1n, [`${D}:3`]: 1n } });
    await instance.issueVoucher(A);
    dest.redeem(A);
    chain.transfer(D, A, 3n);
    chain.transfer(A, B, 3n);
    chain.transfer(A, C, 3n);
    await expect(instance.issueVoucher(B)).rejects.toMatchObject({ code: "GENESIS_HOLDING_ALREADY_USED" });
    await expect(instance.issueVoucher(C)).resolves.toMatchObject({ voucher: { claimant: getAddress(C) } });
  });

  it("burns remove the used unit first and never free a consumed unit: claims never exceed units ever held", async () => {
    // A holds two units of ID 0. One claim uses one of them.
    const { instance, chain, dest } = service({ holdings: { [`${A}:0`]: 2n } });
    await expect(instance.issueVoucher(A)).resolves.toMatchObject({ voucher: { claimant: getAddress(A), quantity: "1" } });
    dest.redeem(A);
    // A burns one unit: the ledger treats the used unit as the one burned, so A's remaining unit is unused, but A can
    // never claim again (hasClaimed) and the burn did not give A a second claim.
    chain.transfer(A, ZERO, 0n);
    await expect(instance.issueVoucher(A)).rejects.toMatchObject({ status: 409, code: "ALREADY_CLAIMED" });
    // The eligibility read reports the issued voucher (settled to REDEEMED by reconciliation); no new voucher is signed.
    await expect(instance.checkEligibility(A)).resolves.toMatchObject({ claimIssued: true });
    // The unit that never backed a claim still qualifies its next holder: two units, two claims, no more.
    chain.transfer(A, B, 0n);
    await expect(instance.issueVoucher(B)).resolves.toMatchObject({ voucher: { claimant: getAddress(B) } });
    dest.redeem(B);
    chain.transfer(B, C, 0n);
    await expect(instance.issueVoucher(C)).rejects.toMatchObject({ status: 403, code: "GENESIS_HOLDING_ALREADY_USED" });
  });

  it("burning the only unit after a claim leaves nothing for anyone and does not reopen the claim", async () => {
    const { instance, chain, dest } = service({ holdings: { [`${A}:2`]: 1n } });
    await instance.issueVoucher(A);
    dest.redeem(A);
    chain.transfer(A, ZERO, 2n);
    await expect(instance.issueVoucher(A)).rejects.toMatchObject({ status: 409, code: "ALREADY_CLAIMED" });
    await expect(instance.issueVoucher(B)).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
  });

  it("a used unit cannot be re-presented with a fresh nonce, a fresh voucher or another wallet", async () => {
    const { instance, chain, dest, signTypedData } = service({ holdings: { [`${A}:1`]: 1n } });
    const first = await instance.issueVoucher(A);
    // Before redemption a repeat request returns the identical voucher and nonce; nothing new is signed.
    const repeat = await instance.issueVoucher(A);
    expect(repeat.voucher.nonce).toBe(first.voucher.nonce);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    dest.redeem(A);
    // After redemption the same wallet gets no voucher at all, and the unit's new holder is refused.
    await expect(instance.issueVoucher(A)).rejects.toMatchObject({ status: 409, code: "ALREADY_CLAIMED" });
    chain.transfer(A, B, 1n);
    await expect(instance.issueVoucher(B)).rejects.toMatchObject({ status: 403, code: "GENESIS_HOLDING_ALREADY_USED" });
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it("releases the holding when a voucher expires unredeemed, and only then", async () => {
    const { instance, chain, dest } = service({ holdings: { [`${A}:0`]: 1n } });
    const issued = await instance.issueVoucher(A);
    chain.transfer(A, B, 0n);
    dest.state.now = Number(issued.voucher.deadline) + 120;
    await expect(instance.issueVoucher(B)).rejects.toMatchObject({ code: "GENESIS_HOLDING_ALREADY_USED" });
    dest.state.now = Number(issued.voucher.deadline) + 121;
    await expect(instance.issueVoucher(B)).resolves.toMatchObject({ voucher: { claimant: getAddress(B) } });
  });

  it("keeps an expired voucher's holding used when it was redeemed in time", async () => {
    const { instance, chain, dest } = service({ holdings: { [`${A}:0`]: 1n } });
    const issued = await instance.issueVoucher(A);
    dest.redeem(A);
    chain.transfer(A, B, 0n);
    dest.state.now = Number(issued.voucher.deadline) + 10_000;
    await expect(instance.issueVoucher(B)).rejects.toMatchObject({ code: "GENESIS_HOLDING_ALREADY_USED" });
  });

  it("fails closed when the transfer history cannot be read", async () => {
    const chain = genesisChain({ [`${A}:0`]: 1n, [`${B}:0`]: 1n });
    const { instance } = service({ chain });
    await instance.issueVoucher(A);
    chain.idle();
    chain.getLogs.mockRejectedValueOnce(new Error("rpc offline"));
    await expect(instance.issueVoucher(B)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
  });

  it("fails closed when the C-Chain provider is behind the ledger", async () => {
    const chain = genesisChain({ [`${A}:0`]: 1n, [`${B}:0`]: 1n });
    const { instance } = service({ chain });
    await instance.issueVoucher(A);
    chain.getBlockNumber.mockResolvedValueOnce(chain.head - 1).mockResolvedValueOnce(chain.head - 1);
    await expect(instance.issueVoucher(B)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
  });

  it("issues no voucher after the free-claim window, even to an unused holder", async () => {
    const { instance, signTypedData } = service({ holdings: { [`${A}:0`]: 1n }, clock: CLAIM_END });
    await expect(instance.issueVoucher(A)).rejects.toMatchObject({ status: 409, code: "CLAIM_WINDOW_CLOSED" });
    expect(signTypedData).not.toHaveBeenCalled();
  });
});

describe("Genesis claim vouchers", () => {
  it("issues one quantity-one voucher bound to the eligibility rule, target and claim window", async () => {
    const { instance, signTypedData } = service({ holdings: { [`${WALLET}:0`]: 1n, [`${WALLET}:2`]: 3n, [`${WALLET}:3`]: 1n } });
    const issued = await instance.issueVoucher(WALLET);
    expect(issued.voucher).toMatchObject({
      claimant: getAddress(WALLET),
      genesisContract: GENESIS_CONTRACT,
      genesisChainId: GENESIS_CHAIN_ID,
      eligibilityRule: ELIGIBILITY_RULE,
      destinationChainId: 43113,
      releaseContract: getAddress(RELEASE),
      tokenId: "987654321",
      quantity: "1",
      allocation: "0",
      nonce: "987654321",
      deadline: String(NOW + 300),
    });
    expect(issued.signature).toBe(TEST_SIGNATURE);
    expect(issued.target).toMatchObject({
      claimContract: getAddress(CLAIM),
      allocation: "0",
      publicAllocation: "0",
      claimStart: String(CLAIM_START),
      claimEnd: String(CLAIM_END),
      publicSaleStart: String(CLAIM_START),
      publicSaleEnd: String(PUBLIC_END),
      publicPriceWei: PRICE.toString(),
      eligibility: "live",
    });
    expect(issued.target).not.toHaveProperty("privateKey");
    expect(signTypedData.mock.calls[0][0]).toEqual({ name: "The Void Genesis Holder Claim", version: "1", chainId: 43113, verifyingContract: getAddress(CLAIM) });
    expect(signTypedData.mock.calls[0][1].ClaimVoucher).toHaveLength(11);
  });

  it("signs with the configured server key and the voucher recovers to the configured signer address", async () => {
    // No injected signer: the service builds its own Wallet from the server secret (test key only).
    const { instance } = service({ signer: null });
    const issued = await instance.issueVoucher(WALLET);
    const domain = { name: "The Void Genesis Holder Claim", version: "1", chainId: 43113, verifyingContract: getAddress(CLAIM) };
    const types = { ClaimVoucher: [
      { name: "claimant", type: "address" }, { name: "genesisContract", type: "address" }, { name: "genesisChainId", type: "uint256" },
      { name: "eligibilityRule", type: "bytes32" }, { name: "destinationChainId", type: "uint256" }, { name: "releaseContract", type: "address" },
      { name: "tokenId", type: "uint256" }, { name: "quantity", type: "uint256" }, { name: "allocation", type: "uint256" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] };
    expect(verifyTypedData(domain, types, issued.voucher, issued.signature)).toBe(loadGenesisClaimConfig(ENV).signerAddress);
    expect(JSON.stringify(issued)).not.toContain(TEST_SIGNER_KEY.slice(2));
  });

  it("refuses vouchers before the window opens and from the second it closes", async () => {
    for (const [clock, code] of [[CLAIM_START - 1, "CLAIM_NOT_OPEN"], [CLAIM_END, "CLAIM_WINDOW_CLOSED"], [CLAIM_END + 1, "CLAIM_WINDOW_CLOSED"]]) {
      const { instance, signTypedData } = service({ clock });
      await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ status: 409, code });
      expect(signTypedData).not.toHaveBeenCalled();
    }
    const { instance } = service({ clock: CLAIM_START });
    await expect(instance.issueVoucher(WALLET)).resolves.toMatchObject({ voucher: { claimant: getAddress(WALLET) } });
  });

  it("issues distinct 256-bit random nonces by default", async () => {
    const make = (wallet) => createGenesisClaimService({
      config: loadGenesisClaimConfig(ENV), signer: { signTypedData: vi.fn().mockResolvedValue(TEST_SIGNATURE), address: SIGNER },
      genesisProvider: genesisChain({ [`${wallet}:0`]: 1n }), reservationStore: createMemoryGenesisClaimReservationStore(), bindingReader: vi.fn().mockResolvedValue(undefined),
      claimStateReader: vi.fn().mockResolvedValue({ alreadyClaimed: false, claimedSupply: 0n }), destinationClock: () => NOW, clock: () => NOW,
    });
    const [first, second] = await Promise.all([make(A).issueVoucher(A), make(B).issueVoucher(B)]);
    for (const { voucher } of [first, second]) {
      expect(voucher.nonce).toMatch(/^[0-9]+$/);
      expect(BigInt(voucher.nonce) < 2n ** 256n).toBe(true);
    }
    expect(first.voucher.nonce).not.toBe(second.voucher.nonce);
  });

  it("never issues a voucher that outlives the claim window", async () => {
    const { instance } = service({ clock: CLAIM_END - 10 });
    const issued = await instance.issueVoucher(WALLET);
    expect(issued.voucher.deadline).toBe(String(CLAIM_END - 1));
  });

  it("still issues a voucher capped at the claim window while the concurrent paid sale is open", async () => {
    // Real binding verification against a sale that opened at claimStart, together with the claims.
    const { instance } = service({ clock: CLAIM_END - 10, destinationProvider: fujiChain(), bindingReader: undefined });
    const issued = await instance.issueVoucher(WALLET);
    expect(issued.voucher.deadline).toBe(String(CLAIM_END - 1));
    expect(issued.target).toMatchObject({ publicSaleStart: String(CLAIM_START), claimEnd: String(CLAIM_END), publicSaleEnd: String(PUBLIC_END) });
  });

  it("rejects already-claimed wallets on the destination contract", async () => {
    const { instance, signTypedData } = service({ alreadyClaimed: true });
    await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ status: 409, code: "ALREADY_CLAIMED" });
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it("has no allocation cap on an open edition, but still enforces a finite one when configured", async () => {
    const open = service({ claimedSupply: 10_000n });
    await expect(open.instance.issueVoucher(WALLET)).resolves.toMatchObject({ voucher: { allocation: "0" } });
    const finite = service({ claimedSupply: 25n, env: { GENESIS_CLAIM_ALLOCATION: "25" } });
    await expect(finite.instance.issueVoucher(WALLET)).rejects.toMatchObject({ status: 409, code: "CLAIM_ALLOCATION_EXHAUSTED" });
  });

  it("fails closed if live contract bindings do not match the configured target", async () => {
    const { instance, signTypedData } = service({
      bindingReader: vi.fn().mockRejectedValue(new ApiError(503, "CLAIM_BINDING_MISMATCH", "The claim target differs.")),
    });
    await expect(instance.issueVoucher(WALLET)).rejects.toMatchObject({ code: "CLAIM_BINDING_MISMATCH", status: 503 });
    expect(signTypedData).not.toHaveBeenCalled();
  });
});

const claimIface = new Interface([
  "function releaseContract() view returns (address)", "function primarySale() view returns (address)", "function tokenId() view returns (uint256)",
  "function allocation() view returns (uint256)", "function publicAllocation() view returns (uint256)", "function destinationChainId() view returns (uint256)",
  "function claimStart() view returns (uint256)", "function claimEnd() view returns (uint256)", "function publicSaleStart() view returns (uint256)", "function publicSaleEnd() view returns (uint256)",
  "function claimWindow() view returns (uint256)", "function publicWindow() view returns (uint256)",
  "function publicPriceWei() view returns (uint256)", "function GENESIS_CONTRACT() view returns (address)", "function GENESIS_CHAIN_ID() view returns (uint256)",
  "function ELIGIBILITY_RULE() view returns (bytes32)", "function signer() view returns (address)", "function claimedSupply() view returns (uint256)",
]);
const releaseIface = new Interface([
  "function maxSupplyOf(uint256 tokenId) view returns (uint256)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function edition(uint256 tokenId) view returns ((bytes32 releaseId,bytes32 editionId,address artist,uint256 maxSupply,uint256 mintedSupply,string metadataUri,bool exists))",
]);
const saleIface = new Interface(["function sales(uint256 tokenId) view returns (uint256 priceWei,uint256 maxSupply,uint256 sold,uint256 perWalletLimit,uint64 startTime,uint64 endTime,bool paused,bool configured)"]);

/** A Fuji provider holding a deployed claim, its open-edition release and its scheduled sale. */
function fujiChain(drift = {}) {
  const claimValues = {
    releaseContract: RELEASE, primarySale: SALE, tokenId: 987654321n, allocation: 0n, publicAllocation: 0n, destinationChainId: 43113n,
    claimStart: BigInt(CLAIM_START), claimEnd: BigInt(CLAIM_END), publicSaleStart: BigInt(CLAIM_START), publicSaleEnd: BigInt(PUBLIC_END), publicPriceWei: PRICE,
    claimWindow: 86_400n, publicWindow: 604_800n,
    GENESIS_CONTRACT, GENESIS_CHAIN_ID: 43114n,
    ELIGIBILITY_RULE,
    signer: SIGNER, claimedSupply: 3n, ...drift.claim,
  };
  // The paid sale runs concurrently with the claims: it opens at claimStart, not at claimEnd.
  const sale = { priceWei: PRICE, maxSupply: 0n, sold: 4n, perWalletLimit: 0n, startTime: BigInt(CLAIM_START), endTime: BigInt(PUBLIC_END), paused: false, configured: true, ...drift.sale };
  const minted = drift.minted ?? 7n;
  return {
    getNetwork: async () => ({ chainId: 43113n }),
    call: async ({ to, data }) => {
      if (getAddress(to) === getAddress(CLAIM)) { const fn = claimIface.parseTransaction({ data }).name; return claimIface.encodeFunctionResult(fn, [claimValues[fn]]); }
      if (getAddress(to) === getAddress(RELEASE)) {
        const fn = releaseIface.parseTransaction({ data }).name;
        if (fn === "maxSupplyOf") return releaseIface.encodeFunctionResult(fn, [drift.maxSupply ?? 0n]);
        if (fn === "ISSUER_ROLE") return releaseIface.encodeFunctionResult(fn, [ISSUER_ROLE]);
        if (fn === "hasRole") {
          const [role, account] = releaseIface.decodeFunctionData(fn, data);
          return releaseIface.encodeFunctionResult(fn, [role === ISSUER_ROLE && getAddress(account) === getAddress(CLAIM) && drift.claimIsIssuer !== false]);
        }
        return releaseIface.encodeFunctionResult(fn, [[`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, WALLET, drift.maxSupply ?? 0n, minted, "ipfs://x", true]]);
      }
      if (getAddress(to) === getAddress(SALE)) return saleIface.encodeFunctionResult("sales", Object.values(sale));
      throw new Error(`unexpected call to ${to}`);
    },
  };
}

describe("live claim binding verification", () => {
  const bindings = (chain) => createGenesisClaimService({ config: loadGenesisClaimConfig(ENV), destinationProvider: chain, genesisProvider: genesisChain(), reservationStore: createMemoryGenesisClaimReservationStore(), signer: { address: SIGNER, signTypedData: vi.fn() }, clock: () => NOW });

  it("accepts an uncapped open edition whose sale is exactly the scheduled public phase", async () => {
    await expect(bindings(fujiChain()).verifyContractBindings()).resolves.toBeUndefined();
  });

  it.each([
    ["a different sale price", { sale: { priceWei: PRICE - 1n } }],
    ["a public start after the claims open", { sale: { startTime: BigInt(CLAIM_START + 1) } }],
    ["a public start at the old claimEnd", { sale: { startTime: BigInt(CLAIM_END) } }],
    ["a public end after seven days", { sale: { endTime: BigInt(PUBLIC_END + 1) } }],
    ["a claim whose public start is not its claim start", { claim: { publicSaleStart: BigInt(CLAIM_END) } }],
    ["an invented sale cap", { sale: { maxSupply: 100n } }],
    ["an unconfigured sale", { sale: { configured: false } }],
    ["supply accounting drift", { minted: 8n }],
    ["a different claim start", { claim: { claimStart: BigInt(CLAIM_START + 1) } }],
    ["a claim deployed with a different window", { claim: { claimWindow: 300n } }],
    ["a different eligibility rule", { claim: { ELIGIBILITY_RULE: `0x${"99".repeat(32)}` } }],
    ["a different signer", { claim: { signer: WALLET } }],
    ["a different release", { claim: { releaseContract: SALE } }],
    ["a claim contract the artist has not granted ISSUER_ROLE", { claimIsIssuer: false }],
  ])("fails closed on %s", async (_label, drift) => {
    await expect(bindings(fujiChain(drift)).verifyContractBindings()).rejects.toMatchObject({ status: 503, code: "CLAIM_BINDING_MISMATCH" });
  });
});

describe("GET /api/claims/config with the real claim service", () => {
  const responseDouble = () => ({ status: null, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body; } });
  const requestDouble = () => ({ method: "GET", url: "/api/claims/config", headers: {}, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() {} });
  const handlerFor = (chain) => createApiHandler({ service: {}, genesisClaim: createGenesisClaimService({ config: loadGenesisClaimConfig(ENV), destinationProvider: chain, genesisProvider: genesisChain(), reservationStore: createMemoryGenesisClaimReservationStore(), signer: { address: SIGNER, signTypedData: vi.fn() }, clock: () => NOW }) });

  it("returns 200 with the exact validated target and no secret", async () => {
    const response = responseDouble();
    await handlerFor(fujiChain())(requestDouble(), response);
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body).data;
    expect(data).toMatchObject({ enabled: true, destinationChainId: 43113, releaseContract: getAddress(RELEASE), primarySale: getAddress(SALE), claimContract: getAddress(CLAIM), tokenId: "987654321", allocation: "0", publicAllocation: "0", claimStart: String(CLAIM_START), claimEnd: String(CLAIM_END), publicSaleStart: String(CLAIM_START), publicSaleEnd: String(PUBLIC_END), publicPriceWei: PRICE.toString(), eligibility: "live" });
    expect(response.body).not.toContain("11".repeat(32));
  });

  it("returns 503 when the deployed claim or sale does not match the configured target", async () => {
    const response = responseDouble();
    await handlerFor(fujiChain({ sale: { priceWei: 1n } }))(requestDouble(), response);
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error.code).toBe("CLAIM_BINDING_MISMATCH");
  });
});

describe("environment schedule and price", () => {
  const MAINNET = { ...ENV, RELEASE_NETWORK: "mainnet", GENESIS_DESTINATION_RPC_URL: "https://api.avax.network/ext/bc/C/rpc" };

  it("lets Fuji run an accelerated 5-minute claim and 10-minute public sale at 0.01 AVAX", () => {
    const loaded = loadGenesisClaimConfig({ ...ENV, GENESIS_CLAIM_WINDOW_SECONDS: "300", GENESIS_PUBLIC_WINDOW_SECONDS: "600", GENESIS_PUBLIC_PRICE_WEI: "10000000000000000" });
    expect(loaded).toMatchObject({ destinationChainId: 43113, claimWindow: 300n, publicWindow: 600n, claimEnd: BigInt(CLAIM_START + 300), publicSaleStart: BigInt(CLAIM_START), publicSaleEnd: BigInt(CLAIM_START + 599), publicPriceWei: 10_000_000_000_000_000n });
  });

  it.each([
    ["equal to", { GENESIS_CLAIM_WINDOW_SECONDS: "600", GENESIS_PUBLIC_WINDOW_SECONDS: "600" }],
    ["longer than", { GENESIS_CLAIM_WINDOW_SECONDS: "601", GENESIS_PUBLIC_WINDOW_SECONDS: "600" }],
  ])("refuses a Fuji claim window %s the public window", (_label, override) => {
    expect(() => loadGenesisClaimConfig({ ...ENV, ...override })).toThrow(/before the public sale ends/i);
  });

  it("defaults to the production 24 hours and 7 days when no windows are set", () => {
    expect(loadGenesisClaimConfig(ENV)).toMatchObject({ claimWindow: 86_400n, publicWindow: 604_800n });
  });

  it("refuses Fuji windows under one minute", () => {
    expect(() => loadGenesisClaimConfig({ ...ENV, GENESIS_CLAIM_WINDOW_SECONDS: "59" })).toThrow(/at least 60 seconds/);
  });

  it("loads mainnet only with the production schedule and 0.25 AVAX", () => {
    expect(loadGenesisClaimConfig(MAINNET)).toMatchObject({ destinationChainId: 43114, claimWindow: 86_400n, publicWindow: 604_800n, publicPriceWei: PRICE });
  });

  // 2026-10-23 8:00 PM to 2026-10-31 11:59:59 PM America/New_York: 705,600 s = 8 days 4 hours.
  const HALLOWEEN = { GENESIS_CLAIM_START: "1792800000", GENESIS_PUBLIC_WINDOW_SECONDS: "705600" };

  it("loads mainnet with the Halloween window: 24-hour claim, sale through 11:59:59 PM ET on Oct 31", () => {
    expect(loadGenesisClaimConfig({ ...MAINNET, ...HALLOWEEN })).toMatchObject({
      claimStart: 1_792_800_000n, claimWindow: 86_400n, claimEnd: 1_792_886_400n,
      publicSaleStart: 1_792_800_000n, publicWindow: 705_600n, publicSaleEnd: 1_793_505_599n, publicPriceWei: PRICE,
    });
  });

  it.each([["the 7-day minimum", "604800"], ["the 14-day maximum", "1209600"]])("loads mainnet with %s", (_label, window) => {
    expect(loadGenesisClaimConfig({ ...MAINNET, GENESIS_PUBLIC_WINDOW_SECONDS: window })).toMatchObject({ publicWindow: BigInt(window) });
  });

  it.each([
    ["an accelerated claim window", { GENESIS_CLAIM_WINDOW_SECONDS: "300" }, /24-hour/],
    ["a 25-hour claim window", { GENESIS_CLAIM_WINDOW_SECONDS: "90000" }, /24-hour/],
    ["an accelerated public window", { GENESIS_PUBLIC_WINDOW_SECONDS: "600" }, /whole hours between 7 and 14 days/],
    ["a public window an hour under 7 days", { GENESIS_PUBLIC_WINDOW_SECONDS: "601200" }, /whole hours between 7 and 14 days/],
    ["a public window an hour over 14 days", { GENESIS_PUBLIC_WINDOW_SECONDS: "1213200" }, /whole hours between 7 and 14 days/],
    ["a year-long public window", { GENESIS_PUBLIC_WINDOW_SECONDS: "31536000" }, /whole hours between 7 and 14 days/],
    ["the Halloween window one second short", { ...HALLOWEEN, GENESIS_PUBLIC_WINDOW_SECONDS: "705599" }, /whole hours between 7 and 14 days/],
    ["the Halloween window one second long", { ...HALLOWEEN, GENESIS_PUBLIC_WINDOW_SECONDS: "705601" }, /whole hours between 7 and 14 days/],
    ["the Fuji test price", { GENESIS_PUBLIC_PRICE_WEI: "10000000000000000" }, /0.25 AVAX/],
  ])("refuses mainnet with %s", (_label, override, message) => {
    expect(() => loadGenesisClaimConfig({ ...MAINNET, ...override })).toThrow(message);
  });
});

describe("Genesis claim configuration", () => {
  it("is disabled unless explicitly enabled", () => {
    expect(loadGenesisClaimConfig({ GENESIS_CLAIM_ENABLED: "false" })).toBeNull();
    expect(() => loadGenesisClaimConfig({ GENESIS_CLAIM_ENABLED: "true" })).toThrow(/GENESIS_CLAIM_RELEASE_CONTRACT/);
  });

  it("loads an uncapped open-edition target with its fixed schedule and the live-ownership rule", () => {
    const loaded = loadGenesisClaimConfig(ENV);
    expect(loaded).toMatchObject({ allocation: 0n, publicAllocation: 0n, claimStart: BigInt(CLAIM_START), claimEnd: BigInt(CLAIM_END), publicSaleStart: BigInt(CLAIM_START), publicSaleEnd: BigInt(PUBLIC_END), publicPriceWei: PRICE, eligibilityRule: ELIGIBILITY_RULE });
  });

  it("ignores obsolete snapshot settings", () => {
    const loaded = loadGenesisClaimConfig({ ...ENV, GENESIS_SNAPSHOT_BLOCK: "1", GENESIS_SNAPSHOT_BLOCK_HASH: "0x1234" });
    expect(loaded).not.toHaveProperty("snapshotBlock");
    expect(loaded.eligibilityRule).toBe(ELIGIBILITY_RULE);
  });

  it.each([
    ["GENESIS_CLAIM_START", "", /GENESIS_CLAIM_START must be a positive integer/],
    ["GENESIS_PUBLIC_PRICE_WEI", "0", /GENESIS_PUBLIC_PRICE_WEI must be a positive integer/],
    ["GENESIS_CLAIM_ALLOCATION", "-1", /non-negative integer/],
    ["GENESIS_PUBLIC_MINT_ALLOCATION", "1.5", /non-negative integer/],
    ["GENESIS_CLAIM_TOKEN_ID", "not-a-number", /non-negative integer/],
    ["GENESIS_CLAIM_RELEASE_CONTRACT", LEGACY_FUJI_SINGLETON, /legacy Fuji V2 singleton/],
    ["GENESIS_CLAIM_SIGNER_PRIVATE_KEY", "0x1234", /server-side 32-byte hex secret/],
    ["GENESIS_CLAIM_SIGNER_PRIVATE_KEY", "", /server-side 32-byte hex secret/],
    ["GENESIS_CLAIM_SIGNER_ADDRESS", "", /GENESIS_CLAIM_SIGNER_ADDRESS must be a non-zero EVM address/],
    ["GENESIS_CLAIM_SIGNER_ADDRESS", "0x1234", /GENESIS_CLAIM_SIGNER_ADDRESS must be a non-zero EVM address/],
    ["GENESIS_CLAIM_SIGNER_ADDRESS", "0x000000000000000000000000000000000000dEaD", /dead placeholder/],
    ["GENESIS_CLAIM_SIGNER_ADDRESS", "0x3C7c9Ac6dD2F2138FD403a62ee283C1c1C2f4E47", /does not derive GENESIS_CLAIM_SIGNER_ADDRESS/],
  ])("rejects a missing or malformed %s", (name, value, message) => {
    expect(() => loadGenesisClaimConfig({ ...ENV, [name]: value })).toThrow(message);
  });
});

describe("startup signer check while GENESIS_CLAIM_ENABLED is unset", () => {
  const address = new Wallet(TEST_SIGNER_KEY).address;
  const base = { GENESIS_CLAIM_SIGNER_PRIVATE_KEY: TEST_SIGNER_KEY, GENESIS_CLAIM_SIGNER_ADDRESS: address };

  it("reports MATCH with the derived public address, case-insensitively, without enabling claims", () => {
    expect(checkGenesisSignerConfig(base)).toEqual({ status: "MATCH", derivedAddress: address });
    expect(checkGenesisSignerConfig({ ...base, GENESIS_CLAIM_SIGNER_ADDRESS: address.toLowerCase() })).toMatchObject({ status: "MATCH" });
    expect(loadGenesisClaimConfig(base)).toBeNull();
  });

  it("reports MISMATCH when the address is not the one the secret derives", () => {
    const result = checkGenesisSignerConfig({ ...base, GENESIS_CLAIM_SIGNER_ADDRESS: "0x3C7c9Ac6dD2F2138FD403a62ee283C1c1C2f4E47" });
    expect(result).toMatchObject({ status: "MISMATCH", derivedAddress: address, reason: expect.stringMatching(/does not derive/) });
  });

  it("reports MISMATCH for a malformed key, a malformed address, and the dead placeholder, without a derived address", () => {
    expect(checkGenesisSignerConfig({ ...base, GENESIS_CLAIM_SIGNER_PRIVATE_KEY: "0x1234" })).toEqual({ status: "MISMATCH", reason: expect.stringMatching(/32-byte hex secret/) });
    expect(checkGenesisSignerConfig({ ...base, GENESIS_CLAIM_SIGNER_ADDRESS: "nope" })).toMatchObject({ status: "MISMATCH", reason: expect.stringMatching(/non-zero EVM address/) });
    expect(checkGenesisSignerConfig({ ...base, GENESIS_CLAIM_SIGNER_ADDRESS: "0x000000000000000000000000000000000000dEaD" })).toMatchObject({ status: "MISMATCH", reason: expect.stringMatching(/dead placeholder/) });
  });

  it("never returns or embeds the secret", () => {
    const secret = TEST_SIGNER_KEY.slice(2);
    for (const env of [base, { ...base, GENESIS_CLAIM_SIGNER_ADDRESS: "0x3C7c9Ac6dD2F2138FD403a62ee283C1c1C2f4E47" }, { ...base, GENESIS_CLAIM_SIGNER_ADDRESS: "bad" }]) {
      expect(JSON.stringify(checkGenesisSignerConfig(env))).not.toContain(secret);
    }
  });

  it("stays ABSENT or INCOMPLETE without throwing when variables are missing", () => {
    expect(checkGenesisSignerConfig({})).toEqual({ status: "ABSENT" });
    expect(checkGenesisSignerConfig({ GENESIS_CLAIM_SIGNER_PRIVATE_KEY: TEST_SIGNER_KEY })).toMatchObject({ status: "INCOMPLETE" });
    expect(checkGenesisSignerConfig({ GENESIS_CLAIM_SIGNER_ADDRESS: address })).toMatchObject({ status: "INCOMPLETE" });
    expect(loadGenesisClaimConfig({})).toBeNull();
  });
});

describe("Genesis reservation reconciliation", () => {
  const CONTRACT = "0x16C7A0f55847F508c9326A4c5AEEa99CcBE488f6";
  const claimed = getAddress("0x6a86efa012feda64b70112022487fee22e67d2fb");
  const idle = getAddress("0x1111111111111111111111111111111111111111");
  const record = (wallet, status, deadline) => ({ claimContract: getAddress(CONTRACT), wallet, block: 1, usedTokenId: "0", balances: { 0: "1", 1: "0", 2: "0", 3: "0" }, deadline: BigInt(deadline), status, voucher: {}, signature: "0x" });
  const seed = async (rows) => { const store = createMemoryGenesisClaimReservationStore(); await store.withLock(CONTRACT, async (tx) => { for (const row of rows) await tx.upsert(row); }); return store; };
  const run = (store, overrides = {}) => reconcileGenesisReservations({ store, claimContract: CONTRACT, readAlreadyClaimed: async (wallet) => wallet === claimed, destinationNow: async () => 2000, ...overrides });
  const statusOf = (store, wallet) => store.rows.get(`${CONTRACT.toLowerCase()}:${wallet.toLowerCase()}`).status;

  it("settles a claimed PENDING row to REDEEMED and an unclaimed expired one to EXPIRED", async () => {
    const store = await seed([record(claimed, "PENDING", 1000), record(idle, "PENDING", 1000)]);
    const result = await run(store, { apply: true });
    expect(result.transitions.map((t) => [t.wallet, t.to])).toEqual([[claimed, "REDEEMED"], [idle, "EXPIRED"]]);
    expect(statusOf(store, claimed)).toBe("REDEEMED");
    expect(statusOf(store, idle)).toBe("EXPIRED");
  });

  it("defaults to a dry run that writes nothing", async () => {
    const store = await seed([record(claimed, "PENDING", 1000)]);
    const result = await run(store);
    expect(result.transitions).toEqual([{ wallet: claimed, from: "PENDING", to: "REDEEMED", applied: false }]);
    expect(statusOf(store, claimed)).toBe("PENDING");
  });

  it("is idempotent: settled rows are neither read nor rewritten on a second run", async () => {
    const store = await seed([record(claimed, "PENDING", 1000)]);
    await run(store, { apply: true });
    const reader = vi.fn().mockResolvedValue(true);
    const again = await run(store, { apply: true, readAlreadyClaimed: reader });
    expect(again).toEqual({ pending: 0, transitions: [] });
    expect(reader).not.toHaveBeenCalled();
  });

  it("leaves an unclaimed voucher that can still be redeemed PENDING, and never reopens EXPIRED rows", async () => {
    const store = await seed([record(idle, "PENDING", 1990), record(getAddress("0x2222222222222222222222222222222222222222"), "EXPIRED", 10)]);
    const result = await run(store, { apply: true });
    expect(result).toEqual({ pending: 1, transitions: [] });
    expect(statusOf(store, idle)).toBe("PENDING");
  });

  it("writes nothing when the chain cannot be read", async () => {
    const store = await seed([record(claimed, "PENDING", 1000), record(idle, "PENDING", 1000)]);
    await expect(run(store, { apply: true, readAlreadyClaimed: async (wallet) => { if (wallet === idle) throw new Error("rpc down"); return true; } })).rejects.toThrow("rpc down");
    expect(statusOf(store, claimed)).toBe("PENDING");
  });

  it("keeps the used-unit ledger identical before and after settlement", async () => {
    const before = await seed([record(claimed, "PENDING", 1000)]);
    const settled = await seed([record(claimed, "PENDING", 1000)]);
    await run(settled, { apply: true });
    const view = async (store) => store.withLock(CONTRACT, async (tx) => (await tx.list()).map((r) => [r.wallet, r.usedTokenId, r.status === "EXPIRED"]));
    expect(await view(settled)).toEqual((await view(before)));
  });
});

describe("Genesis transfer history over a public RPC that caps eth_getLogs at 100 blocks", () => {
  const RPC_SECRET_URL = "https://user:hunter2@rpc.provider.example/ext/bc/C/rpc?apikey=SECRET_KEY_123";
  /** A fake C-Chain RPC that rejects any eth_getLogs range wider than 100 blocks, like the public endpoint. */
  function cappedChain(holdings) {
    const chain = genesisChain(holdings);
    const realGetLogs = chain.getLogs.getMockImplementation();
    chain.ranges = [];
    chain.getLogs = vi.fn(async (filter) => {
      const span = Number(filter.toBlock) - Number(filter.fromBlock) + 1;
      if (span > 100) {
        const error = new Error(`could not coalesce error (error={ "code": -32000, "message": "requested too many blocks from ${filter.fromBlock} to ${filter.toBlock}, maximum is set to 100" }, url=${RPC_SECRET_URL})`);
        error.code = "UNKNOWN_ERROR";
        error.error = { code: -32000, message: "requested too many blocks, maximum is set to 100" };
        throw error;
      }
      chain.ranges.push([Number(filter.fromBlock), Number(filter.toBlock)]);
      return realGetLogs(filter);
    });
    chain.advance = (blocks) => { for (let i = 0; i < blocks; i += 1) chain.idle(); return chain.head; };
    return chain;
  }
  const quietLogger = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() });

  it("the fake RPC rejects a range above 100 blocks and accepts exactly 100", async () => {
    const chain = cappedChain({});
    await expect(chain.getLogs({ address: GENESIS_CONTRACT, fromBlock: 1, toBlock: 101 })).rejects.toThrow(/maximum is set to 100/);
    await expect(chain.getLogs({ address: GENESIS_CONTRACT, fromBlock: 1, toBlock: 100 })).resolves.toBeInstanceOf(Array);
  });

  it("with one pending reservation and the head 5,000 blocks later, a legitimately eligible wallet is eligible and every request is at most 100 blocks", async () => {
    const chain = cappedChain({ [`${A}:0`]: 1n, [`${B}:1`]: 1n });
    const logger = quietLogger();
    const { instance, store } = service({ chain, logger });
    await instance.issueVoucher(A);
    const [pending] = await store.withLock(getAddress(CLAIM), (tx) => tx.list());
    expect(pending.status).toBe("PENDING");
    chain.advance(5_000);
    await expect(instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true, eligibleTokenIds: ["1"], claimIssued: false });
    expect(chain.ranges).toHaveLength(50);
    expect(chain.ranges.every(([from, to]) => to - from + 1 <= 100 && to >= from)).toBe(true);
    expect(chain.ranges[0][0]).toBe(Number(pending.block) + 1);
    expect(chain.ranges.at(-1)[1]).toBe(chain.head);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("covers the history with no gaps and counts boundary transfers exactly once", async () => {
    const chain = cappedChain({ [`${A}:0`]: 1n, [`${B}:1`]: 1n });
    const { instance, store, dest } = service({ chain });
    await instance.issueVoucher(A);
    dest.redeem(A);
    const [record] = await store.withLock(getAddress(CLAIM), (tx) => tx.list());
    const first = Number(record.block) + 1;
    // Put transfers on the last block of one chunk and the first block of the next.
    chain.advance(first + 99 - chain.head - 1);
    const lastOfChunk = chain.transfer(A, C, 0n); // the used unit follows the transfer to C
    expect(lastOfChunk).toBe(first + 99);
    const firstOfNext = chain.transfer(B, D, 1n);
    expect(firstOfNext).toBe(first + 100);
    chain.advance(250);
    await expect(instance.checkEligibility(C)).resolves.toMatchObject({ eligible: false, holdingUsed: true });
    const firstScan = chain.ranges.length;
    await expect(instance.checkEligibility(D)).resolves.toMatchObject({ eligible: true, eligibleTokenIds: ["1"] });
    // The second request reuses the verified history and rescans only the unconfirmed tail.
    expect(chain.ranges.slice(firstScan)).toEqual([[chain.head - 31, chain.head]]);
    // Contiguous, non-overlapping inclusive ranges from the block after the claim to the head.
    let expected = first;
    for (const [from, to] of chain.ranges.slice(0, firstScan)) {
      expect(from).toBe(expected);
      expect(to - from + 1).toBeLessThanOrEqual(100);
      expected = to + 1;
    }
    expect(expected - 1).toBe(chain.head);
    const returned = (await Promise.all(chain.getLogs.mock.results.slice(0, firstScan).map((result) => result.value))).flat().map((log) => log.blockNumber);
    expect(returned.filter((block) => block === lastOfChunk)).toHaveLength(1);
    expect(returned.filter((block) => block === firstOfNext)).toHaveLength(1);
  });

  it.each([
    ["eligibility", (instance) => instance.checkEligibility(B, { requestId: "990d46f9-b929-4328-97e4-593aaa3fa08a" })],
    ["voucher", (instance) => instance.issueVoucher(B, { requestId: "990d46f9-b929-4328-97e4-593aaa3fa08a" })],
  ])("an upstream getLogs failure in the %s path keeps the 503 and logs exactly one sanitized diagnostic", async (_label, call) => {
    const chain = cappedChain({ [`${A}:0`]: 1n, [`${B}:0`]: 1n });
    const logger = quietLogger();
    const { instance, signTypedData } = service({ chain, logger });
    await instance.issueVoucher(A);
    signTypedData.mockClear();
    chain.advance(300);
    const failure = new Error(`server response 429 Too Many Requests (url=${RPC_SECRET_URL}, wallet=${B})`);
    failure.code = "SERVER_ERROR";
    failure.info = { responseStatus: "429 Too Many Requests", requestUrl: RPC_SECRET_URL };
    // Persistent throttling: retries are exhausted and the request fails closed.
    chain.getLogs.mockRejectedValue(failure);
    await expect(call(instance)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
    expect(signTypedData).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("genesis.eligibility.upstream_error", { requestId: "990d46f9-b929-4328-97e4-593aaa3fa08a", stage: "getLogs", providerError: { httpStatus: 429 } });
    const logged = JSON.stringify(logger.warn.mock.calls).toLowerCase();
    for (const secret of [A, B, getAddress(B), "rpc.provider.example", "hunter2", "secret_key_123", "too many requests", "https://"]) {
      expect(logged).not.toContain(secret.toLowerCase());
    }
  });

  it.each([
    ["readHead", (chain) => { chain.getBlockNumber.mockRejectedValueOnce(Object.assign(new Error(`connect ECONNREFUSED ${RPC_SECRET_URL}`), { code: "NETWORK_ERROR" })); }, { providerCode: "NETWORK_ERROR" }],
    ["balances", (chain) => { chain.call.mockRejectedValue(Object.assign(new Error(`execution reverted for ${A}`), { error: { code: -32603, message: `internal ${RPC_SECRET_URL}` } })); }, { rpcCode: -32603 }],
    ["getLogs", (chain) => { chain.advance(5_000); chain.getLogs = vi.fn(async () => { throw new Error(`raw ${RPC_SECRET_URL}`); }); }, null],
  ])("diagnostics for a %s failure carry only the stage and a sanitized code", async (stage, breakChain, providerError) => {
    const chain = cappedChain({ [`${A}:0`]: 1n, [`${B}:0`]: 1n });
    const logger = quietLogger();
    const { instance } = service({ chain, logger });
    await instance.issueVoucher(A);
    breakChain(chain);
    await expect(instance.checkEligibility(B, { requestId: "028f82e7-cbdb-4bcc-8c6b-364899622b02" })).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
    expect(logger.warn.mock.calls).toEqual([["genesis.eligibility.upstream_error", { requestId: "028f82e7-cbdb-4bcc-8c6b-364899622b02", stage, providerError }]]);
    const logged = JSON.stringify(logger.warn.mock.calls).toLowerCase();
    for (const secret of [A.toLowerCase(), B.toLowerCase(), "rpc.provider.example", "hunter2", "secret_key_123", "reverted", "econnrefused", "internal"]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("an eligibility route failure returns the existing 503 to the client with the request ID and logs one diagnostic", async () => {
    const chain = cappedChain({ [`${A}:0`]: 1n, [`${B}:0`]: 1n });
    const logger = quietLogger();
    const { instance } = service({ chain, logger });
    await instance.issueVoucher(A);
    chain.advance(5_000);
    chain.getLogs.mockRejectedValue(Object.assign(new Error(`bad ${RPC_SECRET_URL}`), { error: { code: -32005, message: "limit exceeded" } }));
    const handler = createApiHandler({ service: {}, genesisClaim: instance, logger });
    const response = { status: null, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    const payload = JSON.stringify({ wallet: B });
    const request = { method: "POST", url: "/api/claims/eligibility", headers: { "x-request-id": "028f82e7-cbdb-4bcc-8c6b-364899622b02", "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() { yield Buffer.from(payload); } };
    await handler(request, response);
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error).toMatchObject({ code: "ELIGIBILITY_UNAVAILABLE", requestId: "028f82e7-cbdb-4bcc-8c6b-364899622b02" });
    expect(response.body).not.toContain("rpc.provider.example");
    expect(logger.warn.mock.calls).toEqual([["genesis.eligibility.upstream_error", { requestId: "028f82e7-cbdb-4bcc-8c6b-364899622b02", stage: "getLogs", providerError: { rpcCode: -32005 } }]]);
  });
});

describe("Genesis transfer scan: backoff, pacing and verified reuse on a free public RPC", () => {
  const httpError = (status, headers = {}) => Object.assign(new Error(`server response ${status}`), { code: "SERVER_ERROR", info: { responseStatus: `${status} Error`, responseHeaders: headers } });
  /** A service on a fake clock: sleep advances time, so pacing, backoff and the budget are deterministic. */
  function scanned({ env = {}, holdings = { [`${A}:0`]: 1n, [`${B}:1`]: 1n } } = {}) {
    const clock = { t: 0 };
    const sleep = vi.fn(async (ms) => { clock.t += ms; });
    const chain = genesisChain(holdings);
    const ctx = service({ chain, env, sleep, monotonicNow: () => clock.t, logger: { warn: vi.fn() } });
    return { ...ctx, sleep, clock };
  }
  const prepare = async (ctx, blocks = 5_000) => {
    await ctx.instance.issueVoucher(A);
    for (let i = 0; i < blocks; i += 1) ctx.chain.idle();
    ctx.chain.getLogs.mockClear();
    ctx.chain.getBlock.mockClear();
    ctx.sleep.mockClear();
  };
  const retryWaits = (sleep) => sleep.mock.calls.map(([ms]) => ms).filter((ms) => ms !== 100);

  it("retries a 429 with jittered backoff, then succeeds", async () => {
    const ctx = scanned();
    await prepare(ctx);
    ctx.chain.getLogs.mockRejectedValueOnce(httpError(429));
    await expect(ctx.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true, eligibleTokenIds: ["1"] });
    expect(ctx.chain.getLogs).toHaveBeenCalledTimes(51);
    expect(retryWaits(ctx.sleep)).toEqual([125]); // random 0.5 x base 250 (full jitter, first retry)
  });

  it.each([
    ["provider status 599", httpError(599)],
    ["502 gateway", httpError(502)],
    ["ECONNRESET", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    ["socket hang up", new Error("socket hang up")],
    ["timeout abort", Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })],
  ])("retries %s, then succeeds", async (_label, failure) => {
    const ctx = scanned();
    await prepare(ctx);
    ctx.chain.getLogs.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
    await expect(ctx.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(retryWaits(ctx.sleep)).toEqual([125, 250]);
  });

  it("honors Retry-After, capped at the maximum delay", async () => {
    const ctx = scanned();
    await prepare(ctx);
    ctx.chain.getLogs.mockRejectedValueOnce(httpError(429, { "retry-after": "2" })).mockRejectedValueOnce(httpError(429, { "retry-after": "120" }));
    await expect(ctx.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(retryWaits(ctx.sleep)).toEqual([2_000, 4_000]);
  });

  it("fails closed with 503 when retries are exhausted", async () => {
    const ctx = scanned();
    await prepare(ctx);
    ctx.chain.getLogs.mockRejectedValue(httpError(429));
    await expect(ctx.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
    expect(ctx.chain.getLogs).toHaveBeenCalledTimes(5);
  });

  it("fails fast on a non-retryable error such as an invalid block range", async () => {
    const ctx = scanned();
    await prepare(ctx);
    ctx.chain.getLogs.mockRejectedValue(Object.assign(new Error("bad"), { error: { code: -32602, message: "block range too large" } }));
    await expect(ctx.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
    expect(ctx.chain.getLogs).toHaveBeenCalledTimes(1);
    expect(retryWaits(ctx.sleep)).toEqual([]);
  });

  it("fails closed when the scan exceeds its time budget instead of hanging", async () => {
    const ctx = scanned({ env: { GENESIS_SCAN_BUDGET_MS: "3000", GENESIS_RPC_MAX_ATTEMPTS: "10" } });
    await prepare(ctx);
    ctx.chain.getLogs.mockRejectedValue(httpError(503, { "retry-after": "1" }));
    await expect(ctx.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
    expect(ctx.chain.getLogs.mock.calls.length).toBeLessThan(10);
    expect(ctx.clock.t).toBeLessThanOrEqual(3_000 + 100);
  });

  it("paces sequential getLogs calls by the configured interval", async () => {
    const ctx = scanned({ env: { GENESIS_RPC_PACE_MS: "250" } });
    await prepare(ctx);
    await ctx.instance.checkEligibility(B);
    expect(ctx.sleep.mock.calls.length).toBeGreaterThanOrEqual(50);
    expect(ctx.sleep.mock.calls.every(([ms]) => ms > 0 && ms <= 250)).toBe(true);
  });

  it("reuses the verified history: a repeat request re-checks one block hash and scans only the unconfirmed tail", async () => {
    const ctx = scanned();
    await prepare(ctx);
    await ctx.instance.checkEligibility(B);
    expect(ctx.chain.getLogs).toHaveBeenCalledTimes(50);
    ctx.chain.getLogs.mockClear();
    ctx.chain.getBlock.mockClear();
    ctx.chain.idle();
    await expect(ctx.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(ctx.chain.getLogs).toHaveBeenCalledTimes(1);
    expect(ctx.chain.getLogs.mock.calls[0][0]).toMatchObject({ fromBlock: ctx.chain.head - 32, toBlock: ctx.chain.head });
    expect(ctx.chain.getBlock.mock.calls.map(([block]) => block)).toEqual([ctx.chain.head - 33, ctx.chain.head - 32]);
  });

  it("still counts a transfer made after the cached range", async () => {
    const ctx = scanned();
    await prepare(ctx);
    await ctx.instance.checkEligibility(B);
    ctx.dest.redeem(A);
    ctx.chain.transfer(A, C, 0n); // the used unit moves to C
    await expect(ctx.instance.checkEligibility(C)).resolves.toMatchObject({ eligible: false, holdingUsed: true });
  });

  it("discards the cache and rescans everything when the cached end block hash changed (reorg)", async () => {
    const ctx = scanned();
    await prepare(ctx);
    await ctx.instance.checkEligibility(B);
    ctx.chain.getLogs.mockClear();
    ctx.chain.fork += 1;
    await expect(ctx.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(ctx.chain.getLogs).toHaveBeenCalledTimes(50);
  });

  it("a partial scan failure returns 503 and caches nothing; the next request rescans from the start", async () => {
    const ctx = scanned();
    await prepare(ctx);
    const real = ctx.chain.getLogs.getMockImplementation();
    let calls = 0;
    ctx.chain.getLogs.mockImplementation(async (filter) => { calls += 1; if (calls === 20) throw new Error("unexpected"); return real(filter); });
    await expect(ctx.instance.checkEligibility(B)).rejects.toMatchObject({ status: 503, code: "ELIGIBILITY_UNAVAILABLE" });
    ctx.chain.getLogs.mockClear();
    ctx.chain.getLogs.mockImplementation(real);
    await expect(ctx.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(ctx.chain.getLogs).toHaveBeenCalledTimes(50);
  });

  it("concurrent requests share one scan instead of duplicating it", async () => {
    const ctx = scanned();
    await prepare(ctx);
    const results = await Promise.all([ctx.instance.checkEligibility(B), ctx.instance.checkEligibility(B), ctx.instance.checkEligibility(C)]);
    expect(results.map((r) => r.eligible)).toEqual([true, true, false]);
    expect(ctx.chain.getLogs.mock.calls.length).toBeLessThanOrEqual(50 + 2);
  });

  it("a cold 95-chunk scan on a slow-but-healthy RPC (p95 121 ms, 100 ms pacing, one throttled retry) finishes inside the default budget", async () => {
    const ctx = scanned();
    await prepare(ctx, 9_500);
    const real = ctx.chain.getLogs.getMockImplementation();
    let first = true;
    ctx.chain.getLogs.mockImplementation(async (filter) => {
      ctx.clock.t += 121; // observed p95 latency of api.avax.network eth_getLogs (100 blocks)
      if (first) { first = false; throw httpError(429, { "retry-after": "2" }); }
      return real(filter);
    });
    await expect(ctx.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(ctx.chain.getLogs).toHaveBeenCalledTimes(96);
    // 96 x (100 ms pace + 121 ms) + a 2 s Retry-After is about 23.2 s: over the old 20 s default, inside the 45 s budget.
    expect(ctx.clock.t).toBeGreaterThan(20_000);
    expect(ctx.clock.t).toBeLessThan(45_000);
  });

  it.each([
    ["persistent 429", () => httpError(429)],
    ["persistent 599", () => httpError(599)],
  ])("during %s, concurrent requests share one failing scan, all fail closed, and the cache is untouched", async (_label, failure) => {
    const ctx = scanned();
    await prepare(ctx);
    await ctx.instance.checkEligibility(B); // verified history now cached
    for (let i = 0; i < 2_000; i += 1) ctx.chain.idle();
    const real = ctx.chain.getLogs.getMockImplementation();
    ctx.chain.getLogs.mockClear();
    ctx.chain.getLogs.mockImplementation(async () => { await new Promise((resolve) => { setTimeout(resolve, 5); }); throw failure(); });
    const results = await Promise.allSettled([B, B, C, D, B].map((wallet) => ctx.instance.checkEligibility(wallet)));
    expect(results.every((r) => r.status === "rejected" && r.reason.status === 503 && r.reason.code === "ELIGIBILITY_UNAVAILABLE")).toBe(true);
    expect(ctx.chain.getLogs).toHaveBeenCalledTimes(5); // one scan: its first chunk, 5 attempts
    // The failure is not kept: the next request scans afresh, and only from the cached verified end.
    ctx.chain.getLogs.mockClear();
    ctx.chain.getLogs.mockImplementation(real);
    await expect(ctx.instance.checkEligibility(B)).resolves.toMatchObject({ eligible: true });
    expect(ctx.chain.getLogs).toHaveBeenCalledTimes(21); // 2,032 blocks after the cached end
  });

  it("concurrent voucher requests during throttling share one scan and none is issued", async () => {
    const ctx = scanned({ holdings: { [`${A}:0`]: 1n, [`${B}:1`]: 1n, [`${C}:2`]: 1n, [`${D}:3`]: 1n } });
    await prepare(ctx);
    ctx.signTypedData.mockClear();
    ctx.chain.getLogs.mockImplementation(async () => { await new Promise((resolve) => { setTimeout(resolve, 5); }); throw httpError(429); });
    const results = await Promise.allSettled([B, C, D].map((wallet) => ctx.instance.issueVoucher(wallet)));
    expect(results.every((r) => r.status === "rejected" && r.reason.status === 503)).toBe(true);
    expect(ctx.chain.getLogs).toHaveBeenCalledTimes(5);
    expect(ctx.signTypedData).toHaveBeenCalledTimes(0);
  });

  it("caps the chunk at 100 blocks: smaller is allowed, larger is refused", () => {
    expect(scanOptions({}).chunkBlocks).toBe(100);
    expect(scanOptions({ GENESIS_LOG_CHUNK_BLOCKS: "50" }).chunkBlocks).toBe(50);
    expect(() => scanOptions({ GENESIS_LOG_CHUNK_BLOCKS: "101" })).toThrow(/1 to 100/);
    expect(() => scanOptions({ GENESIS_SCAN_CONFIRMATIONS: "0" })).toThrow();
    expect(scanOptions({}).budgetMs).toBe(45_000);
    expect(() => scanOptions({ GENESIS_SCAN_BUDGET_MS: "60001" })).toThrow(/1000 to 60000/);
  });
});
