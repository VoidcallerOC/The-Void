import { describe, expect, it, vi } from "vitest";
import { Interface, getAddress, id } from "ethers";
import { ApiError } from "./api-errors.js";
import { createApiHandler } from "./api-http.js";
import {
  createGenesisClaimService,
  ELIGIBILITY_RULE,
  ELIGIBILITY_RULE_TEXT,
  GENESIS_CONTRACT,
  GENESIS_CHAIN_ID,
  LEGACY_FUJI_SINGLETON,
  loadGenesisClaimConfig,
} from "./genesis-claim.js";
import { createMemoryGenesisClaimReservationStore } from "./genesis-claim-store.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const RELEASE = "0x2222222222222222222222222222222222222222";
const SALE = "0x3333333333333333333333333333333333333333";
const CLAIM = "0x4444444444444444444444444444444444444444";
const SIGNER = "0x5555555555555555555555555555555555555555";
const TEST_SIGNATURE = `0x${"ab".repeat(65)}`;
const NOW = 1_800_000_000;
const CLAIM_START = NOW - 60;
const CLAIM_END = CLAIM_START + 86_400;
const PUBLIC_END = CLAIM_END + 7 * 86_400 - 1;
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
  GENESIS_CLAIM_SIGNER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
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
      publicSaleEnd: String(PUBLIC_END),
      publicPriceWei: PRICE.toString(),
      eligibility: "live",
    });
    expect(issued.target).not.toHaveProperty("privateKey");
    expect(signTypedData.mock.calls[0][0]).toEqual({ name: "The Void Genesis Holder Claim", version: "1", chainId: 43113, verifyingContract: getAddress(CLAIM) });
    expect(signTypedData.mock.calls[0][1].ClaimVoucher).toHaveLength(11);
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
  "function claimStart() view returns (uint256)", "function claimEnd() view returns (uint256)", "function publicSaleEnd() view returns (uint256)",
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
    claimStart: BigInt(CLAIM_START), claimEnd: BigInt(CLAIM_END), publicSaleEnd: BigInt(PUBLIC_END), publicPriceWei: PRICE,
    claimWindow: 86_400n, publicWindow: 604_800n,
    GENESIS_CONTRACT, GENESIS_CHAIN_ID: 43114n,
    ELIGIBILITY_RULE,
    signer: SIGNER, claimedSupply: 3n, ...drift.claim,
  };
  const sale = { priceWei: PRICE, maxSupply: 0n, sold: 4n, perWalletLimit: 0n, startTime: BigInt(CLAIM_END), endTime: BigInt(PUBLIC_END), paused: false, configured: true, ...drift.sale };
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
    ["a public start before the claim window ends", { sale: { startTime: BigInt(CLAIM_END - 1) } }],
    ["a public end after seven days", { sale: { endTime: BigInt(PUBLIC_END + 1) } }],
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
    expect(data).toMatchObject({ enabled: true, destinationChainId: 43113, releaseContract: getAddress(RELEASE), primarySale: getAddress(SALE), claimContract: getAddress(CLAIM), tokenId: "987654321", allocation: "0", publicAllocation: "0", claimEnd: String(CLAIM_END), publicSaleEnd: String(PUBLIC_END), publicPriceWei: PRICE.toString(), eligibility: "live" });
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
    expect(loaded).toMatchObject({ destinationChainId: 43113, claimWindow: 300n, publicWindow: 600n, claimEnd: BigInt(CLAIM_START + 300), publicSaleEnd: BigInt(CLAIM_START + 899), publicPriceWei: 10_000_000_000_000_000n });
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

  it.each([
    ["an accelerated claim window", { GENESIS_CLAIM_WINDOW_SECONDS: "300" }, /24-hour/],
    ["an accelerated public window", { GENESIS_PUBLIC_WINDOW_SECONDS: "600" }, /7-day/],
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
    expect(loaded).toMatchObject({ allocation: 0n, publicAllocation: 0n, claimStart: BigInt(CLAIM_START), claimEnd: BigInt(CLAIM_END), publicSaleEnd: BigInt(PUBLIC_END), publicPriceWei: PRICE, eligibilityRule: ELIGIBILITY_RULE });
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
  ])("rejects a missing or malformed %s", (name, value, message) => {
    expect(() => loadGenesisClaimConfig({ ...ENV, [name]: value })).toThrow(message);
  });
});
