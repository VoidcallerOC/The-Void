import { getAddress, isAddress } from "ethers";

export const CROSS_CHAIN_STATUS = Object.freeze({
  PROVISIONAL: "PROVISIONAL",
  FINALIZED: "FINALIZED",
  DISPUTED: "DISPUTED",
  INVALIDATED: "INVALIDATED",
});

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const TX = HEX32;
const ZERO = "0x0000000000000000000000000000000000000000";

export class CrossChainLedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CrossChainLedgerError";
    this.code = code;
  }
}

function required(condition, code, message) {
  if (!condition) throw new CrossChainLedgerError(code, message);
}

function hash(value, name) {
  const normalized = String(value || "");
  required(TX.test(normalized), "INVALID_HASH", `${name} must be a 32-byte hex value.`);
  return normalized.toLowerCase();
}

function address(value, name) {
  required(isAddress(value) && getAddress(value) !== ZERO, "INVALID_ADDRESS", `${name} must be a non-zero address.`);
  return getAddress(value);
}

function positiveQuantity(value, name = "quantity") {
  let quantity;
  try { quantity = BigInt(value); } catch { throw new CrossChainLedgerError("INVALID_QUANTITY", `${name} must be an integer quantity.`); }
  required(quantity > 0n, "INVALID_QUANTITY", `${name} must be positive.`);
  return quantity;
}

function chainId(value, name) {
  let id;
  try { id = BigInt(value); } catch { throw new CrossChainLedgerError("INVALID_CHAIN", `${name} must be a positive chain ID.`); }
  required(id > 0n, "INVALID_CHAIN", `${name} must be a positive chain ID.`);
  return Number(id);
}

export function normalizeQuantities(input) {
  required(input && typeof input === "object" && !Array.isArray(input), "INVALID_QUANTITIES", "Token quantities must be an object.");
  const entries = Object.entries(input).map(([tokenId, quantity]) => {
    required(/^\d+$/.test(tokenId), "INVALID_TOKEN_ID", "Token IDs must be non-negative decimal strings.");
    return [tokenId, positiveQuantity(quantity, `quantity for token ${tokenId}`)];
  }).sort(([a], [b]) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  required(entries.length > 0, "EMPTY_QUANTITIES", "At least one token quantity is required.");
  return Object.freeze(Object.fromEntries(entries.map(([tokenId, quantity]) => [tokenId, quantity.toString()])));
}

export function normalizeForwardOperation(input) {
  required(input && typeof input === "object", "INVALID_OPERATION", "A bridge operation is required.");
  const operation = {
    operationId: hash(input.operationId, "operationId"),
    sourceChainId: chainId(input.sourceChainId, "sourceChainId"),
    destinationChainId: chainId(input.destinationChainId, "destinationChainId"),
    sourceBridge: address(input.sourceBridge, "sourceBridge"),
    destinationBridge: address(input.destinationBridge, "destinationBridge"),
    sourceTxHash: hash(input.sourceTxHash, "sourceTxHash"),
    sourceBlock: Number(input.sourceBlock),
    destinationTxHash: input.destinationTxHash == null ? null : hash(input.destinationTxHash, "destinationTxHash"),
    destinationBlock: input.destinationBlock == null ? null : Number(input.destinationBlock),
    senderWallet: address(input.senderWallet, "senderWallet"),
    recipientWallet: address(input.recipientWallet, "recipientWallet"),
    quantities: normalizeQuantities(input.quantities),
    forwardMessageId: hash(input.forwardMessageId || input.operationId, "forwardMessageId"),
    finalityStatus: input.finalityStatus || CROSS_CHAIN_STATUS.PROVISIONAL,
    reconciliationStatus: input.reconciliationStatus || "UNRESOLVED",
    sourceRangeComplete: Boolean(input.sourceRangeComplete),
    destinationRangeComplete: Boolean(input.destinationRangeComplete),
    evidenceComplete: Boolean(input.evidenceComplete),
  };
  required(Number.isSafeInteger(operation.sourceBlock) && operation.sourceBlock > 0, "INVALID_BLOCK", "sourceBlock must be a positive block number.");
  if (operation.destinationBlock !== null) required(Number.isSafeInteger(operation.destinationBlock) && operation.destinationBlock > 0, "INVALID_BLOCK", "destinationBlock must be a positive block number.");
  required(Object.values(CROSS_CHAIN_STATUS).includes(operation.finalityStatus), "INVALID_STATUS", "Invalid finality status.");
  required(["UNRESOLVED", "RECONCILED", "INELIGIBLE"].includes(operation.reconciliationStatus), "INVALID_STATUS", "Invalid reconciliation status.");
  return Object.freeze(operation);
}

export function normalizeDestinationMint(input) {
  required(input && typeof input === "object", "INVALID_MINT", "A destination mint evidence record is required.");
  return Object.freeze({
    operationId: hash(input.operationId, "operationId"),
    messageId: hash(input.messageId, "messageId"),
    destinationTxHash: hash(input.destinationTxHash, "destinationTxHash"),
    destinationBlock: Number(input.destinationBlock),
    recipientWallet: address(input.recipientWallet, "recipientWallet"),
    quantities: normalizeQuantities(input.quantities),
    status: input.status || CROSS_CHAIN_STATUS.PROVISIONAL,
  });
}

export function normalizeReverseOperation(input) {
  required(input && typeof input === "object", "INVALID_REVERSE", "A reverse bridge evidence record is required.");
  return Object.freeze({
    operationId: hash(input.operationId, "operationId"),
    reverseMessageId: hash(input.reverseMessageId, "reverseMessageId"),
    sourceReleaseTxHash: hash(input.sourceReleaseTxHash, "sourceReleaseTxHash"),
    sourceReleaseBlock: Number(input.sourceReleaseBlock),
    quantities: normalizeQuantities(input.quantities),
    recipientWallet: address(input.recipientWallet, "recipientWallet"),
    status: input.status || CROSS_CHAIN_STATUS.PROVISIONAL,
  });
}

function statusFinal(status) { return status === CROSS_CHAIN_STATUS.FINALIZED; }
function sameQuantities(a, b) {
  const aa = normalizeQuantities(a); const bb = normalizeQuantities(b);
  return JSON.stringify(aa) === JSON.stringify(bb);
}

/**
 * Replay only evidence that is complete, finalized, and unambiguous. This function deliberately does
 * not infer per-unit identity from ERC-1155 quantities. A destination transfer from a bucket that has
 * already had any quantity consumed is ambiguous and makes the operation ineligible.
 */
export function replayCrossChainEntitlements({ operations = [], destinationMints = [], destinationTransfers = [], reverseOperations = [], claims = [], requiredRangesComplete = false } = {}) {
  const normalizedOperations = operations.map(normalizeForwardOperation);
  const byOperation = new Map();
  const messages = new Map();
  const unresolved = [];
  const invalid = [];
  const addIssue = (list, code, detail, operationId = null) => list.push(Object.freeze({ code, detail, operationId }));

  for (const operation of normalizedOperations) {
    if (byOperation.has(operation.operationId)) {
      const prior = byOperation.get(operation.operationId);
      if (JSON.stringify(prior) !== JSON.stringify(operation)) addIssue(invalid, "CONFLICTING_OPERATION", "Duplicate operation ID has conflicting evidence.", operation.operationId);
      continue;
    }
    byOperation.set(operation.operationId, operation);
    if (messages.has(operation.forwardMessageId)) addIssue(invalid, "DUPLICATE_MESSAGE", "Forward message ID was replayed.", operation.operationId);
    messages.set(operation.forwardMessageId, operation.operationId);
  }

  const buckets = new Map();
  for (const operation of byOperation.values()) {
    const complete = operation.evidenceComplete && operation.sourceRangeComplete && operation.destinationRangeComplete
      && requiredRangesComplete && statusFinal(operation.finalityStatus)
      && operation.destinationTxHash && operation.destinationBlock;
    if (!complete) addIssue(unresolved, "INCOMPLETE_RECONCILIATION", "Operation lacks complete finalized source and destination evidence.", operation.operationId);
    for (const [tokenId, quantity] of Object.entries(operation.quantities)) {
      buckets.set(`${operation.operationId}:${tokenId}`, { operationId: operation.operationId, tokenId, ownerWallet: operation.recipientWallet, quantity: BigInt(quantity), consumed: 0n, state: complete ? "UNUSED" : "UNRESOLVED" });
    }
  }

  const mintByOperation = new Map();
  for (const mintInput of destinationMints) {
    const mint = normalizeDestinationMint(mintInput);
    const operation = byOperation.get(mint.operationId);
    if (!operation) { addIssue(invalid, "ORPHAN_DESTINATION_MINT", "Destination mint has no verified forward operation.", mint.operationId); continue; }
    if (mint.messageId !== operation.forwardMessageId || mint.destinationTxHash !== operation.destinationTxHash || getAddress(mint.recipientWallet) !== getAddress(operation.recipientWallet) || !sameQuantities(mint.quantities, operation.quantities)) {
      addIssue(invalid, "DESTINATION_MINT_MISMATCH", "Destination mint does not exactly match the verified forward operation.", mint.operationId); continue;
    }
    if (mintByOperation.has(mint.operationId)) { addIssue(invalid, "DUPLICATE_DESTINATION_MINT", "More than one destination mint was supplied.", mint.operationId); continue; }
    mintByOperation.set(mint.operationId, mint);
    if (!statusFinal(mint.status)) addIssue(unresolved, "DESTINATION_NOT_FINAL", "Destination mint is not finalized.", mint.operationId);
  }

  for (const operation of byOperation.values()) {
    if (!mintByOperation.has(operation.operationId)) addIssue(unresolved, "MISSING_DESTINATION_MINT", "Forward operation has no matching finalized destination mint.", operation.operationId);
  }

  // Apply claims before later destination movements. A redeemed claim is permanent; a later
  // transfer or reverse operation must observe the already-consumed quantity and cannot restore it.
  for (const claim of claims) {
    const operationId = hash(claim.operationId, "operationId");
    const tokenId = String(claim.tokenId);
    const quantity = positiveQuantity(claim.quantity);
    const matching = [...buckets.values()].filter((bucket) => bucket.operationId === operationId && bucket.tokenId === tokenId && getAddress(bucket.ownerWallet) === getAddress(claim.claimantWallet));
    if (matching.length !== 1) { addIssue(unresolved, "CLAIM_PROVENANCE_UNRESOLVED", "Claim does not identify exactly one provenance bucket.", operationId); continue; }
    const bucket = matching[0];
    if (claim.status === "REDEEMED") {
      if (bucket.consumed > 0n || bucket.quantity < quantity) addIssue(invalid, "DOUBLE_CONSUMPTION", "The same canonical quantity was consumed twice.", operationId);
      else { bucket.quantity -= quantity; bucket.consumed += quantity; bucket.state = "CONSUMED"; }
    } else if (claim.status === "PENDING") {
      if (bucket.consumed > 0n || bucket.quantity < quantity) addIssue(unresolved, "PENDING_CLAIM_UNAVAILABLE", "Pending claim cannot reserve an unavailable quantity.", operationId);
      else bucket.state = "PROVISIONALLY_RESERVED";
    } else if (claim.status !== "EXPIRED") {
      addIssue(unresolved, "CLAIM_NOT_FINAL", "Only redeemed claims can permanently consume a quantity.", operationId);
    }
  }

  for (const transfer of destinationTransfers) {
    const operationId = hash(transfer.operationId, "operationId");
    const operation = byOperation.get(operationId);
    if (!operation) { addIssue(invalid, "ORPHAN_DESTINATION_TRANSFER", "Destination transfer has no operation provenance.", operationId); continue; }
    const tokenId = String(transfer.tokenId);
    const key = `${operationId}:${tokenId}`;
    const bucket = buckets.get(key);
    if (!bucket) { addIssue(invalid, "UNKNOWN_TOKEN_QUANTITY", "Destination transfer exceeds the bridged token IDs.", operationId); continue; }
    const amount = positiveQuantity(transfer.quantity);
    const to = address(transfer.to, "destination transfer recipient");
    if (bucket.consumed > 0n) {
      bucket.state = "UNRESOLVED";
      addIssue(unresolved, "AMBIGUOUS_DESTINATION_TRANSFER", "A transfer after partial consumption cannot preserve provenance safely.", operationId);
      continue;
    }
    required(bucket.quantity >= amount, "QUANTITY_UNDERFLOW", "Destination transfer exceeds the bridged quantity.");
    bucket.quantity -= amount;
    const recipientKey = `${operationId}:${tokenId}:${to}`;
    const existing = buckets.get(recipientKey);
    if (existing) existing.quantity += amount;
    else buckets.set(recipientKey, { operationId, tokenId, ownerWallet: to, quantity: amount, consumed: 0n, state: bucket.state });
  }

  for (const reverseInput of reverseOperations) {
    const reverse = normalizeReverseOperation(reverseInput);
    const operation = byOperation.get(reverse.operationId);
    if (!operation) { addIssue(invalid, "ORPHAN_REVERSE", "Reverse release has no forward operation.", reverse.operationId); continue; }
    if (!statusFinal(reverse.status)) { addIssue(unresolved, "REVERSE_NOT_FINAL", "Reverse release is not finalized.", reverse.operationId); continue; }
    for (const [tokenId, quantity] of Object.entries(reverse.quantities)) {
      const amount = BigInt(quantity);
      const matching = [...buckets.values()].filter((bucket) => bucket.operationId === reverse.operationId && bucket.tokenId === tokenId && getAddress(bucket.ownerWallet) === getAddress(reverse.recipientWallet));
      const total = matching.reduce((sum, bucket) => sum + bucket.quantity, 0n);
      if (matching.some((bucket) => bucket.consumed > 0n) || total < amount || matching.length !== 1) {
        addIssue(unresolved, "AMBIGUOUS_REVERSE_ALLOCATION", "Aggregate reverse quantity cannot be mapped without inventing per-unit identity.", reverse.operationId);
        continue;
      }
      matching[0].quantity -= amount;
      matching[0].state = "RETURNED";
      addIssue(unresolved, "RETURNED_NOT_REELIGIBLE", "Reverse bridging cannot restore eligibility for a consumed or returned quantity without complete source reconciliation.", reverse.operationId);
    }
  }

  const eligible = [...buckets.values()].filter((bucket) => bucket.state === "UNUSED" && bucket.quantity > 0n && !unresolved.some((issue) => issue.operationId === bucket.operationId) && !invalid.some((issue) => issue.operationId === bucket.operationId));
  return Object.freeze({
    eligible: eligible.length > 0,
    eligibleBuckets: Object.freeze(eligible.map((bucket) => Object.freeze({ ...bucket, quantity: bucket.quantity.toString(), consumed: bucket.consumed.toString() }))),
    buckets: Object.freeze([...buckets.values()].map((bucket) => Object.freeze({ ...bucket, quantity: bucket.quantity.toString(), consumed: bucket.consumed.toString() }))),
    unresolved: Object.freeze(unresolved),
    invalid: Object.freeze(invalid),
    historicalComplete: Boolean(requiredRangesComplete) && unresolved.length === 0 && invalid.length === 0,
  });
}

export function consumeCanonicalEntitlement(state, { operationId, tokenId, ownerWallet, quantity }) {
  const result = replayCrossChainEntitlements({ operations: state.operations, destinationMints: state.destinationMints, destinationTransfers: state.destinationTransfers, reverseOperations: state.reverseOperations, claims: state.claims, requiredRangesComplete: state.requiredRangesComplete });
  const key = `${hash(operationId, "operationId")}:${String(tokenId)}:${getAddress(ownerWallet)}`;
  const bucket = result.buckets.find((candidate) => `${candidate.operationId}:${candidate.tokenId}:${candidate.ownerWallet}` === key);
  required(bucket, "ENTITLEMENT_NOT_FOUND", "Canonical entitlement bucket was not found.");
  required(bucket.state === "UNUSED", "ENTITLEMENT_NOT_AVAILABLE", "Canonical entitlement is not unused.");
  required(BigInt(bucket.quantity) >= positiveQuantity(quantity), "ENTITLEMENT_NOT_AVAILABLE", "Canonical entitlement quantity is insufficient.");
  return Object.freeze({ ...bucket, quantity: (BigInt(bucket.quantity) - BigInt(quantity)).toString(), consumed: (BigInt(bucket.consumed) + BigInt(quantity)).toString(), state: "CONSUMED" });
}
