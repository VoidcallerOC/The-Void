import { getAddress } from "ethers";

function lowerAddress(value) { return getAddress(value).toLowerCase(); }
function lowerHash(value) { return String(value).toLowerCase(); }

function operationRow(row) {
  return Object.freeze({
    operationId: lowerHash(row.operation_id),
    sourceChainId: Number(row.source_chain_id),
    destinationChainId: Number(row.destination_chain_id),
    sourceBridge: getAddress(row.source_bridge),
    destinationBridge: getAddress(row.destination_bridge),
    sourceTxHash: lowerHash(row.source_tx_hash),
    sourceBlock: Number(row.source_block),
    destinationTxHash: row.destination_tx_hash ? lowerHash(row.destination_tx_hash) : null,
    destinationBlock: row.destination_block == null ? null : Number(row.destination_block),
    senderWallet: getAddress(row.sender_wallet),
    recipientWallet: getAddress(row.recipient_wallet),
    quantities: row.quantities,
    finalityStatus: row.finality_status,
    reconciliationStatus: row.reconciliation_status,
    evidenceComplete: row.evidence_complete,
    sourceRangeComplete: row.source_range_complete,
    destinationRangeComplete: row.destination_range_complete,
  });
}

function provenanceRow(row) {
  return Object.freeze({
    operationId: lowerHash(row.operation_id),
    tokenId: String(row.token_id),
    ownerWallet: getAddress(row.owner_wallet),
    quantity: String(row.quantity),
    availableQuantity: String(row.available_quantity),
    consumedQuantity: String(row.consumed_quantity),
    state: row.state,
  });
}

/**
 * Isolated store for cross-chain evidence. It intentionally shares the exact advisory-lock
 * namespace used by genesis-claim-store.js. Nothing in the live claim service calls this store yet.
 */
export function createGenesisCrossChainLedgerStore(pool) {
  if (!pool) throw new TypeError("A database pool is required.");
  return Object.freeze({
    async withLock(scope, fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`genesis-claim-ledger:${String(scope).toLowerCase()}`]);
        const tx = {
          async getOperation(operationId) {
            const { rows } = await client.query("SELECT * FROM genesis_cross_chain_operations WHERE operation_id=$1", [lowerHash(operationId)]);
            return rows[0] ? operationRow(rows[0]) : null;
          },
          async listProvenance(operationId) {
            const { rows } = await client.query("SELECT * FROM genesis_cross_chain_provenance WHERE operation_id=$1 ORDER BY token_id, owner_wallet", [lowerHash(operationId)]);
            return rows.map(provenanceRow);
          },
          async upsertOperation(operation) {
            await client.query(
              `INSERT INTO genesis_cross_chain_operations
                (operation_id, source_chain_id, destination_chain_id, source_bridge, destination_bridge, source_tx_hash, source_block,
                 destination_tx_hash, destination_block, sender_wallet, recipient_wallet, quantities, finality_status, reconciliation_status,
                 evidence_complete, source_range_complete, destination_range_complete)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17)
               ON CONFLICT (operation_id) DO UPDATE SET
                 destination_tx_hash=EXCLUDED.destination_tx_hash, destination_block=EXCLUDED.destination_block,
                 finality_status=EXCLUDED.finality_status, reconciliation_status=EXCLUDED.reconciliation_status,
                 evidence_complete=EXCLUDED.evidence_complete, source_range_complete=EXCLUDED.source_range_complete,
                 destination_range_complete=EXCLUDED.destination_range_complete, updated_at=now()`,
              [lowerHash(operation.operationId), operation.sourceChainId, operation.destinationChainId,
                lowerAddress(operation.sourceBridge), lowerAddress(operation.destinationBridge), lowerHash(operation.sourceTxHash), operation.sourceBlock,
                operation.destinationTxHash ? lowerHash(operation.destinationTxHash) : null, operation.destinationBlock ?? null,
                lowerAddress(operation.senderWallet), lowerAddress(operation.recipientWallet), JSON.stringify(operation.quantities),
                operation.finalityStatus, operation.reconciliationStatus, operation.evidenceComplete,
                operation.sourceRangeComplete, operation.destinationRangeComplete],
            );
          },
          async upsertProvenance(bucket) {
            await client.query(
              `INSERT INTO genesis_cross_chain_provenance
                (operation_id, token_id, owner_wallet, quantity, available_quantity, consumed_quantity, state)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (operation_id, token_id, owner_wallet) DO UPDATE SET
                 quantity=EXCLUDED.quantity, available_quantity=EXCLUDED.available_quantity,
                 consumed_quantity=EXCLUDED.consumed_quantity, state=EXCLUDED.state, updated_at=now()`,
              [lowerHash(bucket.operationId), String(bucket.tokenId), lowerAddress(bucket.ownerWallet),
                String(bucket.quantity), String(bucket.availableQuantity ?? bucket.quantity), String(bucket.consumedQuantity ?? 0), bucket.state],
            );
          },
          async recordMessage(message) {
            await client.query(
              `INSERT INTO genesis_cross_chain_messages
                (message_id, operation_id, direction, chain_id, tx_hash, block_number, status, payload_hash)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (message_id) DO UPDATE SET status=EXCLUDED.status, payload_hash=EXCLUDED.payload_hash`,
              [lowerHash(message.messageId), lowerHash(message.operationId), message.direction, message.chainId,
                lowerHash(message.txHash), message.blockNumber, message.status, message.payloadHash ? lowerHash(message.payloadHash) : null],
            );
          },
          async recordClaim(claim) {
            await client.query(
              `INSERT INTO genesis_cross_chain_claims
                (claim_id, operation_id, token_id, claimant_wallet, quantity, status, reservation_reference, redeemed_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (claim_id) DO UPDATE SET status=EXCLUDED.status, redeemed_at=EXCLUDED.redeemed_at`,
              [lowerHash(claim.claimId), lowerHash(claim.operationId), String(claim.tokenId), lowerAddress(claim.claimantWallet),
                String(claim.quantity), claim.status, claim.reservationReference, claim.redeemedAt || null],
            );
          },
        };
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
    },
  });
}

/** In-process store for deterministic tests and tooling. */
export function createMemoryGenesisCrossChainLedgerStore() {
  const operations = new Map();
  const messages = new Map();
  const provenance = new Map();
  const claims = new Map();
  let tail = Promise.resolve();
  return Object.freeze({
    operations, messages, provenance, claims,
    async withLock(scope, fn) {
      const run = tail.then(async () => {
        const operationCopy = new Map(operations);
        const messageCopy = new Map(messages);
        const provenanceCopy = new Map(provenance);
        const claimCopy = new Map(claims);
        const tx = {
          async getOperation(operationId) { return operationCopy.get(lowerHash(operationId)) || null; },
          async listProvenance(operationId) { return [...provenanceCopy.values()].filter((row) => row.operationId === lowerHash(operationId)); },
          async upsertOperation(operation) { operationCopy.set(lowerHash(operation.operationId), Object.freeze({ ...operation })); },
          async upsertProvenance(bucket) {
            const key = `${lowerHash(bucket.operationId)}:${String(bucket.tokenId)}:${lowerAddress(bucket.ownerWallet)}`;
            provenanceCopy.set(key, Object.freeze({ ...bucket }));
          },
          async recordMessage(message) {
            const key = lowerHash(message.messageId);
            const prior = messageCopy.get(key);
            if (prior && JSON.stringify(prior) !== JSON.stringify(message)) throw new Error("CONFLICTING_MESSAGE");
            messageCopy.set(key, Object.freeze({ ...message }));
          },
          async recordClaim(claim) {
            const key = lowerHash(claim.claimId);
            const prior = claimCopy.get(key);
            if (prior && JSON.stringify(prior) !== JSON.stringify(claim)) throw new Error("CONFLICTING_CLAIM");
            claimCopy.set(key, Object.freeze({ ...claim }));
          },
        };
        const result = await fn(tx);
        operations.clear(); for (const [key, value] of operationCopy) operations.set(key, value);
        messages.clear(); for (const [key, value] of messageCopy) messages.set(key, value);
        provenance.clear(); for (const [key, value] of provenanceCopy) provenance.set(key, value);
        claims.clear(); for (const [key, value] of claimCopy) claims.set(key, value);
        return result;
      });
      tail = run.catch(() => {});
      return run;
    },
  });
}
