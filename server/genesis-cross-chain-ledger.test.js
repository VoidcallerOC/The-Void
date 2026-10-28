import { describe, expect, it } from "vitest";
import { createMemoryGenesisCrossChainLedgerStore } from "./genesis-cross-chain-ledger-store.js";
import { replayCrossChainEntitlements, consumeCanonicalEntitlement, normalizeForwardOperation } from "./genesis-cross-chain-ledger.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const SOURCE_BRIDGE = "0x68539f95FB2758327A9C7EdEDa1002b0F3Ec8992";
const DESTINATION_BRIDGE = "0x0d6Fa9968aa57295217737379c44eBbc1130B1Fa";
const OP = "0x9177a86035d7cbe5d07009ac2e621a8963b4c02a9a31f7487c555298fa37b22e";
const SOURCE_TX = "0xb479536e539be0518a7112fe25af033e83578c557574466822405677a24285ca";
const DEST_TX = "0xb7788753a09d0fba95d7d84e3d1a021b0137d8c866f107f4ab22d2bc6702d402";
const REVERSE = "0x9293adf79d673445976f6a7b1c021b00c8edac72bc8613d5843362dedf7f3ee6";
const RELEASE_TX = "0xa5bfbe1e039ff56979341680be101859b978ce67cdb74ca53c8b6e9d193fb3cb";
const base = (overrides = {}) => ({
  operationId: OP, forwardMessageId: OP, sourceChainId: 43114, destinationChainId: 36463, sourceBridge: SOURCE_BRIDGE, destinationBridge: DESTINATION_BRIDGE,
  sourceTxHash: SOURCE_TX, sourceBlock: 100, destinationTxHash: DEST_TX, destinationBlock: 200, senderWallet: A, recipientWallet: A,
  quantities: { 1: "1", 2: "1", 3: "1" }, finalityStatus: "FINALIZED", reconciliationStatus: "RECONCILED", sourceRangeComplete: true, destinationRangeComplete: true, evidenceComplete: true, ...overrides,
});
const mint = (overrides = {}) => ({ operationId: OP, messageId: OP, destinationTxHash: DEST_TX, destinationBlock: 200, recipientWallet: A, quantities: { 1: "1", 2: "1", 3: "1" }, status: "FINALIZED", ...overrides });

function replay(extra = {}) {
  return replayCrossChainEntitlements({ operations: [base()], destinationMints: [mint()], requiredRangesComplete: true, ...extra });
}

describe("Genesis cross-chain fixtures", () => {
  it("retains the supplied forward and reverse correlation identifiers without claiming historical completeness", () => {
    expect(OP).toMatch(/^0x[0-9a-f]{64}$/);
    expect(SOURCE_TX).toMatch(/^0x[0-9a-f]{64}$/);
    expect(DEST_TX).toMatch(/^0x[0-9a-f]{64}$/);
    expect(REVERSE).toMatch(/^0x[0-9a-f]{64}$/);
    expect(RELEASE_TX).toMatch(/^0x[0-9a-f]{64}$/);
    const result = replay({ reverseOperations: [{ operationId: OP, reverseMessageId: REVERSE, sourceReleaseTxHash: RELEASE_TX, sourceReleaseBlock: 300, recipientWallet: A, quantities: { 1: "1" }, status: "FINALIZED" }], requiredRangesComplete: false });
    expect(result.historicalComplete).toBe(false);
    expect(result.eligible).toBe(false);
  });
});

describe("deterministic cross-chain replay", () => {
  it("requires complete finalized source and destination evidence", () => {
    expect(replay({ operations: [base({ evidenceComplete: false })] })).toMatchObject({ eligible: false, historicalComplete: false });
    expect(replay({ operations: [base({ finalityStatus: "PROVISIONAL" })] }).unresolved.map((x) => x.code)).toContain("INCOMPLETE_RECONCILIATION");
  });

  it("rejects a destination mint without a matching verified forward operation", () => {
    const result = replay({ destinationMints: [mint({ operationId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })] });
    expect(result.eligible).toBe(false);
    expect(result.invalid.map((x) => x.code)).toContain("ORPHAN_DESTINATION_MINT");
  });

  it("rejects mismatched destination quantities and duplicate destination execution", () => {
    const mismatch = replay({ destinationMints: [mint({ quantities: { 1: "2", 2: "1", 3: "1" } })] });
    expect(mismatch.invalid.map((x) => x.code)).toContain("DESTINATION_MINT_MISMATCH");
    const duplicate = replay({ destinationMints: [mint(), mint()] });
    expect(duplicate.invalid.map((x) => x.code)).toContain("DUPLICATE_DESTINATION_MINT");
  });

  it("allows an entirely unused supported destination transfer to preserve provenance", () => {
    const result = replay({ destinationTransfers: [{ operationId: OP, tokenId: "1", quantity: "1", to: B }] });
    expect(result.eligible).toBe(true);
    expect(result.eligibleBuckets).toContainEqual(expect.objectContaining({ tokenId: "1", ownerWallet: B, quantity: "1", state: "UNUSED" }));
  });

  it("fails closed when a destination transfer follows any consumed quantity", () => {
    const result = replay({ claims: [{ operationId: OP, tokenId: "1", claimantWallet: A, quantity: "1", status: "REDEEMED" }], destinationTransfers: [{ operationId: OP, tokenId: "1", quantity: "1", to: B }] });
    expect(result.eligible).toBe(false);
    expect(result.unresolved.map((x) => x.code)).toContain("AMBIGUOUS_DESTINATION_TRANSFER");
  });

  it("permanently consumes a redeemed entitlement and never restores it through a reverse bridge", () => {
    const result = replay({ claims: [{ operationId: OP, tokenId: "1", claimantWallet: A, quantity: "1", status: "REDEEMED" }], reverseOperations: [{ operationId: OP, reverseMessageId: REVERSE, sourceReleaseTxHash: RELEASE_TX, sourceReleaseBlock: 300, recipientWallet: A, quantities: { 1: "1" }, status: "FINALIZED" }] });
    expect(result.eligible).toBe(false);
    expect(result.buckets.find((bucket) => bucket.tokenId === "1" && bucket.ownerWallet === A)).toMatchObject({ consumed: "1", state: "CONSUMED" });
    expect(result.unresolved.map((x) => x.code)).toContain("AMBIGUOUS_REVERSE_ALLOCATION");
  });

  it("does not permanently consume a pending or expired reservation", () => {
    const pending = replay({ claims: [{ operationId: OP, tokenId: "1", claimantWallet: A, quantity: "1", status: "PENDING" }] });
    expect(pending.buckets.find((bucket) => bucket.tokenId === "1" && bucket.ownerWallet === A)).toMatchObject({ consumed: "0", state: "PROVISIONALLY_RESERVED" });
    const expired = replay({ claims: [{ operationId: OP, tokenId: "1", claimantWallet: A, quantity: "1", status: "EXPIRED" }] });
    expect(expired.buckets.find((bucket) => bucket.tokenId === "1" && bucket.ownerWallet === A)).toMatchObject({ consumed: "0", state: "UNUSED" });
  });

  it("refuses aggregate reverse quantities rather than inventing per-unit mappings", () => {
    const result = replay({ reverseOperations: [{ operationId: OP, reverseMessageId: REVERSE, sourceReleaseTxHash: RELEASE_TX, sourceReleaseBlock: 300, recipientWallet: A, quantities: { 3: "2" }, status: "FINALIZED" }] });
    expect(result.unresolved.map((x) => x.code)).toContain("AMBIGUOUS_REVERSE_ALLOCATION");
    expect(result.eligible).toBe(false);
  });

  it("rejects duplicate and conflicting operation records", () => {
    const result = replay({ operations: [base(), base({ recipientWallet: B })] });
    expect(result.invalid.map((x) => x.code)).toContain("CONFLICTING_OPERATION");
  });

  it("rejects attempts to consume a canonical quantity twice", () => {
    const result = replay({ claims: [
      { operationId: OP, tokenId: "1", claimantWallet: A, quantity: "1", status: "REDEEMED" },
      { operationId: OP, tokenId: "1", claimantWallet: A, quantity: "1", status: "REDEEMED" },
    ] });
    expect(result.invalid.map((x) => x.code)).toContain("DOUBLE_CONSUMPTION");
  });

  it("is deterministic for the same normalized evidence", () => {
    const input = { operations: [base()], destinationMints: [mint()], requiredRangesComplete: true };
    expect(replayCrossChainEntitlements(input)).toEqual(replayCrossChainEntitlements(input));
    expect(normalizeForwardOperation(base()).quantities).toEqual({ 1: "1", 2: "1", 3: "1" });
  });

  it("requires one exact bucket for an isolated consumption operation", () => {
    const state = { operations: [base()], destinationMints: [mint()], destinationTransfers: [], reverseOperations: [], claims: [], requiredRangesComplete: true };
    expect(consumeCanonicalEntitlement(state, { operationId: OP, tokenId: "2", ownerWallet: A, quantity: "1" })).toMatchObject({ state: "CONSUMED", consumed: "1", quantity: "0" });
  });
});

describe("cross-chain persistence lock and idempotency", () => {
  it("persists provenance buckets under the shared lock", async () => {
    const store = createMemoryGenesisCrossChainLedgerStore();
    const operation = base();
    await store.withLock("0xclaimcontract", async (tx) => {
      await tx.upsertOperation(operation);
      await tx.upsertProvenance({ operationId: OP, tokenId: "1", ownerWallet: A, quantity: "1", availableQuantity: "1", consumedQuantity: "0", state: "UNUSED" });
    });
    await store.withLock("0xclaimcontract", async (tx) => {
      await expect(tx.listProvenance(OP)).resolves.toEqual([
        expect.objectContaining({ operationId: OP, tokenId: "1", ownerWallet: A, quantity: "1", availableQuantity: "1", consumedQuantity: "0", state: "UNUSED" }),
      ]);
    });
    expect(store.provenance.size).toBe(1);
  });

  it("shares the direct claim lock namespace and resumes idempotently", async () => {
    const store = createMemoryGenesisCrossChainLedgerStore();
    const operation = base();
    await store.withLock("0xclaimcontract", async (tx) => {
      await tx.upsertOperation(operation);
      await tx.recordMessage({ messageId: OP, operationId: OP, direction: "FORWARD", chainId: 43114, txHash: SOURCE_TX, blockNumber: 100, status: "FINALIZED" });
    });
    await store.withLock("0xclaimcontract", async (tx) => {
      await tx.upsertOperation(operation);
      await tx.recordMessage({ messageId: OP, operationId: OP, direction: "FORWARD", chainId: 43114, txHash: SOURCE_TX, blockNumber: 100, status: "FINALIZED" });
    });
    expect(store.operations.size).toBe(1);
    expect(store.messages.size).toBe(1);
  });

  it("rolls back partial processing after a conflicting message", async () => {
    const store = createMemoryGenesisCrossChainLedgerStore();
    await expect(store.withLock("0xclaimcontract", async (tx) => {
      await tx.recordMessage({ messageId: OP, operationId: OP, direction: "FORWARD", chainId: 43114, txHash: SOURCE_TX, blockNumber: 100, status: "FINALIZED" });
      await tx.recordMessage({ messageId: OP, operationId: OP, direction: "FORWARD", chainId: 43114, txHash: DEST_TX, blockNumber: 200, status: "FINALIZED" });
    })).rejects.toThrow("CONFLICTING_MESSAGE");
    expect(store.messages.size).toBe(0);
  });
});
