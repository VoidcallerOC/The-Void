import { AbiCoder, getAddress, id, keccak256 } from "ethers";
import { describe, expect, it } from "vitest";
import { buildWeekendTree, verifyWeekendProof, weekendLeaf, WEEKEND_CAMPAIGN } from "./genesis-weekend-merkle.js";
import { computeWeekendSnapshot, SOURCE_BRIDGE, snapshotHashFor, WEEKEND_RULE, WEEKEND_RULE_TEXT } from "./genesis-weekend-snapshot.js";

const A = getAddress("0x00000000000000000000000000000000000000a1");
const B = getAddress("0x00000000000000000000000000000000000000b2");
const C = getAddress("0x00000000000000000000000000000000000000c3");
const GROTTO_ONLY = getAddress("0x626b1AeAdB9Fc0b465B40aDE4F4bBF0C01C9Db40");
const CLAIMANT = getAddress("0x6a86EfA012fEDA64b70112022487fEE22E67d2fb");
const BRIDGE = getAddress(SOURCE_BRIDGE);
const T = 1_793_400_000;

// A consistent two-chain world: A and B hold on C-Chain, the bridge holds 2 units of id 0 and 1 of id 3,
// represented on The Grotto by GROTTO_ONLY (2 x id 0) and B (1 x id 3). CLAIMANT claimed earlier with id 0.
function world(overrides = {}) {
  const base = {
    cchain: {
      block: 99_000_000, blockHash: `0x${"11".repeat(32)}`, timestamp: T,
      balances: { [A]: { 0: 1 }, [B]: { 1: 2 }, [CLAIMANT]: { 0: 1 }, [BRIDGE]: { 0: 2, 3: 1 } },
      mintsMinusBurns: [4n, 2n, 0n, 1n],
      independentMintsMinusBurns: [4n, 2n, 0n, 1n],
    },
    grotto: {
      block: 151_000, blockHash: `0x${"22".repeat(32)}`, timestamp: T - 7200, nextBlockTimestamp: null,
      balances: { [GROTTO_ONLY]: { 0: 2 }, [B]: { 3: 1 } },
      mintsMinusBurns: [2n, 0n, 0n, 1n],
    },
    priorClaimants: [CLAIMANT],
    historicalClaimedSupply: 1n,
    historicalClaims: [{ wallet: CLAIMANT, transactionHash: "0xabc", usedTokenId: 0 }],
    bridgeActivity: [],
  };
  return { ...base, ...overrides, cchain: { ...base.cchain, ...overrides.cchain }, grotto: { ...base.grotto, ...overrides.grotto } };
}

describe("weekend Merkle allowlist", () => {
  it("matches the contract's leaf encoding and campaign", () => {
    expect(WEEKEND_CAMPAIGN).toBe(id("the-void:genesis-weekend-claim:v1"));
    const inner = keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256", "address"], [WEEKEND_CAMPAIGN, 43114, A]));
    expect(weekendLeaf(A)).toBe(keccak256(inner));
    expect(WEEKEND_RULE).toBe(id(WEEKEND_RULE_TEXT));
  });

  it("proves every member, rejects non-members and other wallets' proofs, for odd and even sizes", () => {
    for (const size of [1, 2, 3, 5, 8, 13]) {
      const wallets = Array.from({ length: size }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, "0")}`));
      const tree = buildWeekendTree(wallets);
      for (const wallet of wallets) expect(verifyWeekendProof(tree.root, wallet, tree.proof(wallet))).toBe(true);
      expect(tree.proof(C)).toBeNull();
      if (size > 1) expect(verifyWeekendProof(tree.root, wallets[1], tree.proof(wallets[0]))).toBe(false);
    }
  });

  it("is deterministic regardless of input order and duplicates", () => {
    expect(buildWeekendTree([A, B, C]).root).toBe(buildWeekendTree([C, A, B, A]).root);
  });
});

describe("weekend eligibility snapshot", () => {
  it("lists C-Chain-only, Grotto-only and both-chain holders once each and excludes claimants and custody", () => {
    const result = computeWeekendSnapshot(world());
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.eligible.map(({ wallet }) => wallet).sort()).toEqual([A, B, GROTTO_ONLY].sort());
    expect(result.eligible.find(({ wallet }) => wallet === B).sources).toEqual(["c-chain", "grotto"]);
    expect(result.eligible.find(({ wallet }) => wallet === GROTTO_ONLY).sources).toEqual(["grotto"]);
    expect(result.excluded.map(({ wallet, reason }) => [wallet, reason]).sort()).toEqual([[BRIDGE, "BRIDGE_OR_SYSTEM_ADDRESS"], [CLAIMANT, "PRIOR_CLAIM"]].sort());
    expect(result.reconciliation.eligibleBySource).toEqual({ cchainOnly: 1, grottoOnly: 1, both: 1 });
    const tree = buildWeekendTree(result.eligible.map(({ wallet }) => wallet));
    expect(result.root).toBe(tree.root);
    expect(result.snapshotHash).toBe(snapshotHashFor({ cchainBlock: 99_000_000, cchainBlockHash: `0x${"11".repeat(32)}`, grottoBlock: 151_000, grottoBlockHash: `0x${"22".repeat(32)}`, root: tree.root, wallets: tree.wallets }));
  });

  it("refuses a unit in flight from C-Chain to The Grotto (locked, not yet minted): no double count", () => {
    // A bridged 1 x id 1 to C: C-Chain custody already holds it, the Grotto mint has not happened.
    const result = computeWeekendSnapshot(world({ cchain: { balances: { [A]: { 0: 1 }, [B]: { 1: 1 }, [CLAIMANT]: { 0: 1 }, [BRIDGE]: { 0: 2, 1: 1, 3: 1 } } } }));
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/Token 1: bridge custody 1 != Grotto wrapped supply 0/);
  });

  it("refuses a unit in flight back from The Grotto (burned, not yet released)", () => {
    const result = computeWeekendSnapshot(world({ grotto: { balances: { [GROTTO_ONLY]: { 0: 1 }, [B]: { 3: 1 } }, mintsMinusBurns: [1n, 0n, 0n, 1n] } }));
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/Token 0: bridge custody 2 != Grotto wrapped supply 1/);
  });

  it("refuses an incomplete C-Chain holder set", () => {
    const result = computeWeekendSnapshot(world({ cchain: { mintsMinusBurns: [5n, 2n, 0n, 1n] } }));
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/C-Chain token 0: holder balances 4 != mints minus burns 5/);
  });

  it("refuses when the two indexers disagree on issuance, or the second indexer is missing", () => {
    // The first indexer dropped a mint of id 1 to a wallet no other log mentions: both of its sums miss it.
    const dropped = computeWeekendSnapshot(world({ cchain: { independentMintsMinusBurns: [4n, 3n, 0n, 1n] } }));
    expect(dropped.ok).toBe(false);
    expect(dropped.failures.join(" ")).toMatch(/token 1: indexers disagree on mints minus burns \(2 vs 3\)/);
    expect(computeWeekendSnapshot(world({ cchain: { independentMintsMinusBurns: undefined } })).failures.join(" ")).toMatch(/No independent second indexer/);
  });

  it("refuses bridge activity in the quiet window and a stale Grotto block", () => {
    expect(computeWeekendSnapshot(world({ bridgeActivity: [{ chain: "c-chain", kind: "TokensBridged", transactionHash: "0x1", timestamp: T + 60 }] })).ok).toBe(false);
    expect(computeWeekendSnapshot(world({ grotto: { nextBlockTimestamp: T - 10 } })).ok).toBe(false);
    expect(computeWeekendSnapshot(world({ grotto: { timestamp: T + 1 } })).ok).toBe(false);
    expect(computeWeekendSnapshot(world({ bridgeActivity: null })).ok).toBe(false);
  });

  it("refuses when historical claims do not reconcile, or a used unit left its claimant", () => {
    expect(computeWeekendSnapshot(world({ historicalClaimedSupply: 2n })).ok).toBe(false);
    expect(computeWeekendSnapshot(world({ priorClaimants: [] })).ok).toBe(false);
    // The claimant transferred its used id 0 unit to C: refused instead of making C eligible on a used unit.
    const moved = computeWeekendSnapshot(world({ cchain: { balances: { [A]: { 0: 1 }, [B]: { 1: 2 }, [C]: { 0: 1 }, [BRIDGE]: { 0: 2, 3: 1 } } } }));
    expect(moved.ok).toBe(false);
    expect(moved.failures.join(" ")).toMatch(/no longer holds token 0/);
  });

  it("gives a wallet holding on both chains exactly one leaf", () => {
    const result = computeWeekendSnapshot(world());
    expect(result.eligibleWallets).toBe(3);
    expect(result.eligible.filter(({ wallet }) => wallet === B)).toHaveLength(1);
  });
});
