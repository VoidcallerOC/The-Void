import { Interface, getAddress, ZeroAddress } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { createMemoryGenesisClaimReservationStore } from "../server/genesis-claim-store.js";
import { APPLY_AUTHORIZATION, RELEASE_CONTRACT, TARGETS, runSettlement, settleTarget } from "./settle-genesis-reservations-mainnet.mjs";

const CLAIM_INTERFACE = new Interface(["event GenesisHolderClaimed(address indexed claimant, address indexed releaseContract, uint256 indexed tokenId, uint256 quantity, uint256 nonce, bytes32 voucherHash)"]);
const RELEASE_INTERFACE = new Interface(["event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)"]);
const hex32 = (value) => `0x${String(value).padStart(64, "0")}`;
const rowFor = (target, overrides = {}) => ({
  claimContract: getAddress(target.claimContract),
  wallet: getAddress(target.wallet),
  block: target.eligibilityBlock,
  usedTokenId: target.usedTokenId,
  balances: { 0: "4", 1: "2", 2: "0", 3: "21" },
  deadline: target.deadline,
  status: "PENDING",
  voucher: { claimant: target.wallet, nonce: "1" },
  signature: `0x${"ab".repeat(65)}`,
  ...overrides,
});
const receiptFor = (target, { malformed = false } = {}) => {
  const claim = CLAIM_INTERFACE.encodeEventLog(CLAIM_INTERFACE.getEvent("GenesisHolderClaimed"), [target.wallet, RELEASE_CONTRACT, 1n, 1n, 1n, hex32("1")]);
  const mint = RELEASE_INTERFACE.encodeEventLog(RELEASE_INTERFACE.getEvent("TransferSingle"), [target.claimContract, ZeroAddress, target.wallet, 1n, 1n]);
  return {
    status: 1,
    to: target.claimContract,
    blockNumber: target.eligibilityBlock + 10,
    blockHash: hex32("abcd"),
    logs: malformed ? [{ address: RELEASE_CONTRACT, topics: [], data: "0x" }] : [
      { address: target.claimContract, topics: claim.topics, data: claim.data },
      { address: RELEASE_CONTRACT, topics: mint.topics, data: mint.data },
    ],
  };
};
const chainFor = (targets = TARGETS, overrides = {}) => ({
  readReceipt: vi.fn(async (hash) => {
    const target = targets.find((item) => item.receipt === hash);
    return receiptFor(target);
  }),
  readHasClaimed: vi.fn(async () => true),
  readBlockNumber: vi.fn(async () => 98865533),
  ...overrides,
});
const seed = async (rows) => {
  const store = createMemoryGenesisClaimReservationStore();
  for (const row of rows) await store.withLock(row.claimContract, (tx) => tx.upsert(row));
  return store;
};
const statusOf = async (store, target) => (await store.withLock(target.claimContract, (tx) => tx.list())).find((row) => row.wallet.toLowerCase() === target.wallet.toLowerCase()).status;

expect(APPLY_AUTHORIZATION).toBe("OWNER_APPROVED_P0_GENESIS_SETTLEMENT");

describe("exact Genesis settlement maintenance runner", () => {
  it("produces a receipt-verified dry run and writes nothing", async () => {
    const store = await seed(TARGETS.map((target) => rowFor(target)));
    const chain = chainFor();
    const result = await runSettlement({ store, chain, apply: false, logger: () => {} });
    expect(result).toMatchObject({ mode: "DRY_RUN", expectedTransitions: 2, appliedTransitions: 0 });
    expect(result.targets.map((target) => target.outcome)).toEqual(["WOULD_REDEEM", "WOULD_REDEEM"]);
    expect(await statusOf(store, TARGETS[0])).toBe("PENDING");
    expect(await statusOf(store, TARGETS[1])).toBe("PENDING");
  });

  it("rejects a stale exact preimage", async () => {
    const store = await seed([rowFor(TARGETS[0], { block: TARGETS[0].eligibilityBlock + 1 })]);
    await expect(settleTarget({ store, target: TARGETS[0], chain: chainFor(), logger: () => {} })).rejects.toThrow("preimage mismatch");
  });

  it("rejects a target outside the immutable contract/wallet allowlist", async () => {
    const wrong = { ...TARGETS[0], wallet: "0x1111111111111111111111111111111111111111" };
    const store = await seed([rowFor(TARGETS[0])]);
    await expect(settleTarget({ store, target: wrong, chain: chainFor(), logger: () => {} })).rejects.toThrow("immutable two-record allowlist");
  });

  it("rejects duplicate target rows before chain or database mutation", async () => {
    const row = rowFor(TARGETS[0]);
    const store = { withLock: async (_contract, fn) => fn({ list: async () => [row, row] }) };
    const chain = chainFor();
    await expect(settleTarget({ store, target: TARGETS[0], chain, apply: true, logger: () => {} })).rejects.toThrow("Expected exactly one reservation row");
    expect(chain.readReceipt).not.toHaveBeenCalled();
  });

  it("rolls back an RPC failure through the existing memory store transaction", async () => {
    const store = await seed([rowFor(TARGETS[0])]);
    const chain = chainFor([], { readReceipt: vi.fn(async () => { throw new Error("RPC unavailable"); }) });
    await expect(settleTarget({ store, target: TARGETS[0], chain, apply: true, logger: () => {} })).rejects.toThrow("RPC unavailable");
    expect(await statusOf(store, TARGETS[0])).toBe("PENDING");
  });

  it("reports partial completion without reversing the first committed target", async () => {
    const store = await seed(TARGETS.map((target) => rowFor(target)));
    const chain = chainFor(TARGETS, { readHasClaimed: vi.fn(async (contract) => {
      if (contract.toLowerCase() === TARGETS[1].claimContract.toLowerCase()) throw new Error("recovery RPC unavailable");
      return true;
    }) });
    await expect(runSettlement({ store, chain, apply: true, logger: () => {} })).rejects.toMatchObject({ results: [{ applied: true }] });
    expect(await statusOf(store, TARGETS[0])).toBe("REDEEMED");
    expect(await statusOf(store, TARGETS[1])).toBe("PENDING");
  });

  it("is idempotent on a rerun and does not rewrite an already REDEEMED row", async () => {
    const store = await seed(TARGETS.map((target) => rowFor(target)));
    const chain = chainFor();
    await runSettlement({ store, chain, apply: true, logger: () => {} });
    const second = await runSettlement({ store, chain, apply: true, logger: () => {} });
    expect(second).toMatchObject({ mode: "APPLY", expectedTransitions: 2, appliedTransitions: 0, alreadyRedeemed: 2 });
    expect(second.targets.map((target) => target.outcome)).toEqual(["NOOP_ALREADY_REDEEMED", "NOOP_ALREADY_REDEEMED"]);
  });

  it("rejects a receipt missing either the claim event or mint event", async () => {
    const store = await seed([rowFor(TARGETS[0])]);
    const chain = chainFor([], { readReceipt: vi.fn(async () => receiptFor(TARGETS[0], { malformed: true })) });
    await expect(settleTarget({ store, target: TARGETS[0], chain, logger: () => {} })).rejects.toThrow("required claim and mint events");
  });
});
