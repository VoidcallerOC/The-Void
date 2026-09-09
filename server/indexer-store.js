import { withTransaction } from "./db.js";
import { normalizeBlockTimestamp } from "./indexer-utils.js";

function lower(value) { return String(value || "").toLowerCase(); }
function address(value, label = "address") {
  const normalized = lower(value);
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
}
function numeric(value, label, { positive = false } = {}) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || positive && parsed === 0n) throw new Error();
    return parsed.toString();
  } catch { throw new Error(`${label} is invalid.`); }
}

export class IndexerStore {
  constructor(db) { if (!db?.query) throw new TypeError("IndexerStore requires a database executor."); this.db = db; }

  async getCheckpoint({ chainId, address: contractAddress }) {
    const { rows } = await this.db.query("SELECT * FROM indexer_checkpoints WHERE chain_id=$1 AND contract_address=$2", [chainId, lower(contractAddress)]);
    return rows[0] || null;
  }

  async setCheckpoint({ chainId, address: contractAddress, contractType, nextBlock, lastProcessedBlock = undefined, lastProcessedHash = undefined, finalizedBlock = undefined, status = "IDLE", lastError = undefined, latestKnownBlock = undefined, markRunStarted = false, markRunSucceeded = false, markRunCompleted = false, rpcFailure = false, databaseFailure = false }) {
    const has = (value) => value !== undefined;
    const { rows } = await this.db.query(`INSERT INTO indexer_checkpoints (chain_id, contract_address, contract_type, next_block, last_processed_block, last_processed_hash, finalized_block, status, last_error, latest_known_block, last_run_started_at, last_successful_run_at, last_completed_run_at, rpc_failures, database_failures, failure_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $16 THEN now() ELSE NULL END,CASE WHEN $17 THEN now() ELSE NULL END,CASE WHEN $18 THEN now() ELSE NULL END,CASE WHEN $19 THEN 1 ELSE 0 END,CASE WHEN $20 THEN 1 ELSE 0 END,CASE WHEN $19 OR $20 THEN 1 ELSE 0 END) ON CONFLICT (chain_id, contract_address) DO UPDATE SET contract_type=EXCLUDED.contract_type, next_block=EXCLUDED.next_block, last_processed_block=CASE WHEN $11 THEN EXCLUDED.last_processed_block ELSE indexer_checkpoints.last_processed_block END, last_processed_hash=CASE WHEN $12 THEN EXCLUDED.last_processed_hash ELSE indexer_checkpoints.last_processed_hash END, finalized_block=CASE WHEN $13 THEN EXCLUDED.finalized_block ELSE indexer_checkpoints.finalized_block END, status=EXCLUDED.status, last_error=CASE WHEN $14 THEN EXCLUDED.last_error ELSE indexer_checkpoints.last_error END, latest_known_block=CASE WHEN $15 THEN EXCLUDED.latest_known_block ELSE indexer_checkpoints.latest_known_block END, last_run_started_at=CASE WHEN $16 THEN now() ELSE indexer_checkpoints.last_run_started_at END, last_successful_run_at=CASE WHEN $17 THEN now() ELSE indexer_checkpoints.last_successful_run_at END, last_completed_run_at=CASE WHEN $18 THEN now() ELSE indexer_checkpoints.last_completed_run_at END, rpc_failures=indexer_checkpoints.rpc_failures + CASE WHEN $19 THEN 1 ELSE 0 END, database_failures=indexer_checkpoints.database_failures + CASE WHEN $20 THEN 1 ELSE 0 END, failure_count=indexer_checkpoints.failure_count + CASE WHEN $19 OR $20 THEN 1 ELSE 0 END, updated_at=now() RETURNING *`, [chainId, lower(contractAddress), contractType, nextBlock, lastProcessedBlock ?? null, lastProcessedHash ?? null, finalizedBlock ?? null, status, lastError ?? null, latestKnownBlock ?? null, has(lastProcessedBlock), has(lastProcessedHash), has(finalizedBlock), has(lastError), has(latestKnownBlock), markRunStarted, markRunSucceeded, markRunCompleted, rpcFailure, databaseFailure]);
    return rows[0];
  }

  async getIndexerHealth({ chainId = null } = {}) {
    const { rows } = await this.db.query(`SELECT chain_id, MIN(last_processed_block) AS current_indexed_block, MAX(latest_known_block) AS latest_known_block, MIN(finalized_block) AS finalized_block, CASE WHEN MIN(last_processed_block) IS NULL OR MAX(latest_known_block) IS NULL THEN NULL ELSE GREATEST(MAX(latest_known_block) - MIN(last_processed_block), 0) END AS indexer_lag, MAX(last_successful_run_at) AS last_successful_run_at, MAX(last_run_started_at) AS last_run_started_at, MAX(last_completed_run_at) AS last_completed_run_at, SUM(rpc_failures) AS rpc_failures, SUM(database_failures) AS database_failures, (array_agg(last_error ORDER BY updated_at DESC) FILTER (WHERE last_error IS NOT NULL))[1] AS last_error, array_agg(jsonb_build_object('address', contract_address, 'type', contract_type, 'status', status, 'nextBlock', next_block, 'currentIndexedBlock', last_processed_block, 'latestKnownBlock', latest_known_block, 'finalizedBlock', finalized_block, 'updatedAt', updated_at) ORDER BY contract_address) AS contracts FROM indexer_checkpoints WHERE ($1::bigint IS NULL OR chain_id=$1) GROUP BY chain_id ORDER BY chain_id`, [chainId]);
    return rows;
  }

  async acquireWorkerLease({ leaseKey = "voidcaller-indexer", ownerId, ttlMs }) {
    const { rows } = await this.db.query(`INSERT INTO indexer_worker_leases (lease_key, owner_id, acquired_at, heartbeat_at) VALUES ($1,$2,now(),now()) ON CONFLICT (lease_key) DO UPDATE SET owner_id=EXCLUDED.owner_id, acquired_at=now(), heartbeat_at=now() WHERE indexer_worker_leases.owner_id=$2 OR indexer_worker_leases.heartbeat_at < now() - ($3::bigint * interval '1 millisecond') RETURNING *`, [leaseKey, ownerId, ttlMs]);
    return rows[0] || null;
  }

  async heartbeatWorkerLease({ leaseKey = "voidcaller-indexer", ownerId }) {
    const { rows } = await this.db.query("UPDATE indexer_worker_leases SET heartbeat_at=now() WHERE lease_key=$1 AND owner_id=$2 RETURNING *", [leaseKey, ownerId]);
    return rows[0] || null;
  }

  async releaseWorkerLease({ leaseKey = "voidcaller-indexer", ownerId }) {
    await this.db.query("DELETE FROM indexer_worker_leases WHERE lease_key=$1 AND owner_id=$2", [leaseKey, ownerId]);
  }

  async getBlock({ chainId, blockNumber }) {
    const { rows } = await this.db.query("SELECT * FROM chain_blocks WHERE chain_id=$1 AND block_number=$2 AND is_canonical=true", [chainId, blockNumber]);
    return rows[0] || null;
  }

  async recordBlock({ chainId, blockNumber, blockHash, parentHash, blockTimestamp }) {
    const timestamp = blockTimestamp instanceof Date ? blockTimestamp : normalizeBlockTimestamp(blockTimestamp);
    const { rows } = await this.db.query(`INSERT INTO chain_blocks (chain_id, block_number, block_hash, parent_hash, block_timestamp, is_canonical) VALUES ($1,$2,$3,$4,$5,true) ON CONFLICT (chain_id, block_number) DO UPDATE SET block_hash=EXCLUDED.block_hash, parent_hash=EXCLUDED.parent_hash, block_timestamp=EXCLUDED.block_timestamp, is_canonical=true, indexed_at=now() RETURNING *`, [chainId, blockNumber, lower(blockHash), lower(parentHash), timestamp]);
    await this.db.query(`INSERT INTO chain_block_observations (chain_id, block_number, block_hash, parent_hash, block_timestamp) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [chainId, blockNumber, lower(blockHash), lower(parentHash), timestamp]);
    return rows[0];
  }

  async handleReorg({ chainId, fromBlock, replacementHash }) {
    return withTransaction(this.db, async (client) => {
      await client.query("UPDATE chain_blocks SET is_canonical=false WHERE chain_id=$1 AND block_number >= $2", [chainId, fromBlock]);
      await client.query("UPDATE chain_block_observations SET is_canonical=false WHERE chain_id=$1 AND block_number >= $2 AND block_hash <> $3", [chainId, fromBlock, lower(replacementHash)]);
      await client.query("UPDATE blockchain_events SET is_canonical=false WHERE chain_id=$1 AND block_number >= $2", [chainId, fromBlock]);
      await client.query("UPDATE transfers SET is_canonical=false WHERE chain_id=$1 AND block_number >= $2", [chainId, fromBlock]);
      await client.query("UPDATE ownership_snapshots SET synchronization_watermark='REORG_PENDING', updated_at=now() WHERE chain_id=$1 AND source_block_number >= $2", [chainId, fromBlock]);
      await client.query(`UPDATE listings SET status='REORGED', updated_at=now() WHERE chain_id=$1 AND (created_block_number >= $2 OR id IN (SELECT listing_id FROM purchases WHERE chain_id=$1 AND block_number >= $2) OR id IN (SELECT l.id FROM listings l JOIN contracts mc ON mc.id=l.marketplace_contract_id JOIN blockchain_events e ON e.chain_id=l.chain_id AND e.contract_address=mc.address WHERE l.chain_id=$1 AND e.block_number >= $2 AND e.event_type IN ('ListingCreated','ListingCancelled','ListingExpired','ListingSold') AND COALESCE(e.event_data->>'listingId','') ~ '^[0-9]+$' AND l.listing_id=(e.event_data->>'listingId')::numeric))`, [chainId, fromBlock]);
      await client.query("UPDATE purchases SET status='REORGED', reconciled_at=now() WHERE chain_id=$1 AND block_number >= $2", [chainId, fromBlock]);
      await client.query("UPDATE transactions SET status='REORGED', updated_at=now() WHERE chain_id=$1 AND block_number >= $2", [chainId, fromBlock]);
      await client.query(`INSERT INTO indexer_rebuild_jobs (chain_id, from_block, state, updated_at) VALUES ($1,$2,'PENDING',now()) ON CONFLICT (chain_id) DO UPDATE SET from_block=LEAST(indexer_rebuild_jobs.from_block, EXCLUDED.from_block), state='PENDING', last_error=NULL, started_at=NULL, completed_at=NULL, updated_at=now()`, [chainId, fromBlock]);
      return { chainId, fromBlock, replacementHash };
    });
  }

  async getPendingRebuildJob({ chainId }) {
    const { rows } = await this.db.query("SELECT * FROM indexer_rebuild_jobs WHERE chain_id=$1 AND state IN ('PENDING','FAILED') ORDER BY updated_at ASC LIMIT 1", [chainId]);
    return rows[0] || null;
  }

  async rebuildDerivedState({ chainId }) {
    await this.db.query("UPDATE indexer_rebuild_jobs SET state='RUNNING', started_at=now(), last_error=NULL, updated_at=now() WHERE chain_id=$1", [chainId]);
    try {
      await withTransaction(this.db, async (client) => {
        await client.query("DELETE FROM ownership_snapshots WHERE chain_id=$1", [chainId]);
        await client.query(`WITH movements AS (SELECT chain_id, contract_address, token_id, to_wallet AS wallet_address, amount::numeric AS delta, block_number, block_hash, log_index FROM transfers WHERE chain_id=$1 AND is_canonical=true AND to_wallet <> '0x0000000000000000000000000000000000000000' UNION ALL SELECT chain_id, contract_address, token_id, from_wallet AS wallet_address, -amount::numeric AS delta, block_number, block_hash, log_index FROM transfers WHERE chain_id=$1 AND is_canonical=true AND from_wallet <> '0x0000000000000000000000000000000000000000'), balances AS (SELECT chain_id, contract_address, token_id, wallet_address, SUM(delta) AS amount FROM movements GROUP BY chain_id, contract_address, token_id, wallet_address HAVING SUM(delta) > 0), latest AS (SELECT DISTINCT ON (chain_id, contract_address, token_id, wallet_address) chain_id, contract_address, token_id, wallet_address, block_number, block_hash, log_index FROM movements ORDER BY chain_id, contract_address, token_id, wallet_address, block_number DESC, log_index DESC) INSERT INTO ownership_snapshots (chain_id, contract_address, token_id, wallet_address, amount, source_block_number, source_block_hash, synchronization_watermark) SELECT balances.chain_id, balances.contract_address, balances.token_id, balances.wallet_address, balances.amount, latest.block_number, latest.block_hash, latest.block_number::text || ':' || latest.log_index::text FROM balances JOIN latest USING (chain_id, contract_address, token_id, wallet_address)`, [chainId]);
        await client.query("DELETE FROM listing_status_history WHERE listing_id IN (SELECT id FROM listings WHERE chain_id=$1)", [chainId]);
        await client.query("DELETE FROM purchases WHERE chain_id=$1", [chainId]);
        await client.query("DELETE FROM listings WHERE chain_id=$1", [chainId]);
        await client.query("DELETE FROM marketplace_event_projections WHERE chain_id=$1", [chainId]);
        await client.query("DELETE FROM transactions WHERE chain_id=$1 AND transaction_type IN ('LISTING_CREATE','LISTING_CANCEL','PURCHASE') AND status NOT IN ('PENDING','SUBMITTED')", [chainId]);
      });
      const { rows: events } = await this.db.query("SELECT event_data FROM blockchain_events WHERE chain_id=$1 AND is_canonical=true AND is_malformed=false AND event_type IN ('ListingCreated','ListingCancelled','ListingExpired','ListingSold') ORDER BY block_number ASC, log_index ASC", [chainId]);
      for (const event of events) await this.applyMarketplaceEvent(event.event_data);
      await this.db.query("UPDATE indexer_rebuild_jobs SET state='COMPLETED', completed_at=now(), updated_at=now() WHERE chain_id=$1", [chainId]);
      return { chainId, replayedMarketplaceEvents: events.length };
    } catch (error) {
      await this.db.query("UPDATE indexer_rebuild_jobs SET state='FAILED', last_error=$2, updated_at=now() WHERE chain_id=$1", [chainId, error.message]).catch(() => {});
      throw error;
    }
  }

  async recordEvent({ chainId, contractAddress, transactionHash, logIndex, blockNumber, blockHash, eventType, eventData = {}, blockTimestamp = null, isMalformed = false, errorMessage = null }) {
    const { rows } = await this.db.query(`INSERT INTO blockchain_events (chain_id, contract_address, transaction_hash, log_index, block_number, block_hash, event_type, event_data, block_timestamp, is_malformed, error_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (chain_id, contract_address, transaction_hash, log_index) DO NOTHING RETURNING *`, [chainId, lower(contractAddress), lower(transactionHash), logIndex, blockNumber, lower(blockHash), eventType, eventData, blockTimestamp, isMalformed, errorMessage]);
    return rows[0] || null;
  }

  async applyTransfer({ chainId, contractAddress, transactionHash, blockNumber, blockHash, logIndex, eventType, from, to, tokenId, amount, blockTimestamp, raw = {} }) {
    return withTransaction(this.db, async (client) => {
      const inserted = await client.query(`INSERT INTO transfers (chain_id, contract_address, token_id, from_wallet, to_wallet, amount, transaction_hash, block_number, block_hash, log_index, event_type, event_data, block_timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (chain_id, transaction_hash, log_index) DO NOTHING RETURNING *`, [chainId, lower(contractAddress), tokenId, lower(from), lower(to), amount, lower(transactionHash), blockNumber, lower(blockHash), logIndex, eventType, raw, blockTimestamp]);
      if (!inserted.rows[0]) return { duplicate: true };
      if (from !== "0x0000000000000000000000000000000000000000") await this.adjustOwnership(client, { chainId, contractAddress, tokenId, wallet: from, delta: -BigInt(amount), blockNumber, blockHash, watermark: `${blockNumber}:${logIndex}` });
      if (to !== "0x0000000000000000000000000000000000000000") await this.adjustOwnership(client, { chainId, contractAddress, tokenId, wallet: to, delta: BigInt(amount), blockNumber, blockHash, watermark: `${blockNumber}:${logIndex}` });
      await client.query(`UPDATE blockchain_events SET event_data=event_data || $5::jsonb WHERE chain_id=$1 AND contract_address=$2 AND transaction_hash=$3 AND log_index=$4`, [chainId, lower(contractAddress), lower(transactionHash), logIndex, JSON.stringify({ projectionApplied: true })]);
      return { duplicate: false, transfer: inserted.rows[0] };
    });
  }

  async applyMarketplaceEvent(event) {
    return withTransaction(this.db, async (client) => {
      const marker = await client.query(`INSERT INTO marketplace_event_projections (chain_id, marketplace_address, transaction_hash, log_index, listing_id, event_type) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *`, [event.chainId, address(event.marketplaceAddress, "marketplaceAddress"), lower(event.transactionHash), event.logIndex, numeric(event.listingId, "listingId", { positive: true }), event.eventType]);
      if (!marker.rows[0]) return { duplicate: true };
      const marketplaceContract = await client.query("SELECT id FROM contracts WHERE chain_id=$1 AND address=$2 AND contract_type='MARKETPLACE' LIMIT 1", [event.chainId, address(event.marketplaceAddress, "marketplaceAddress")]);
      if (!marketplaceContract.rows[0]) throw new Error("Marketplace contract is not registered for indexed event.");

      if (event.eventType === "ListingCreated") {
        const tokenContract = await client.query("SELECT id FROM contracts WHERE chain_id=$1 AND address=$2 AND contract_type='ERC1155' LIMIT 1", [event.chainId, address(event.tokenContractAddress, "tokenContractAddress")]);
        if (!tokenContract.rows[0]) throw new Error("Token contract is not registered for indexed event.");
        const { rows } = await client.query(`INSERT INTO listings (chain_id, marketplace_contract_id, listing_id, seller_wallet, token_contract_id, token_id, amount, remaining_amount, price_wei, currency, expires_at, status, created_tx_hash, created_block_number, created_block_hash, created_log_index, application_metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'native',$10,'ACTIVE',$11,$12,$13,$14,$15) ON CONFLICT (chain_id, marketplace_contract_id, listing_id) DO UPDATE SET seller_wallet=EXCLUDED.seller_wallet, token_contract_id=EXCLUDED.token_contract_id, token_id=EXCLUDED.token_id, amount=EXCLUDED.amount, remaining_amount=EXCLUDED.remaining_amount, price_wei=EXCLUDED.price_wei, currency='native', expires_at=EXCLUDED.expires_at, status='ACTIVE', created_tx_hash=EXCLUDED.created_tx_hash, created_block_number=EXCLUDED.created_block_number, created_block_hash=EXCLUDED.created_block_hash, created_log_index=EXCLUDED.created_log_index, application_metadata=EXCLUDED.application_metadata, updated_at=now() RETURNING *`, [event.chainId, marketplaceContract.rows[0].id, event.listingId, address(event.sellerWallet, "sellerWallet"), tokenContract.rows[0].id, numeric(event.tokenId, "tokenId"), numeric(event.amount, "amount", { positive: true }), numeric(event.remainingAmount, "remainingAmount", { positive: true }), numeric(event.priceWei, "priceWei", { positive: true }), event.expiresAt, lower(event.transactionHash), event.blockNumber, lower(event.blockHash), event.logIndex, JSON.stringify({ authority: "BLOCKCHAIN_EVENT" })]);
        await client.query(`INSERT INTO listing_status_history (listing_id, status, transaction_hash, block_number, block_hash, log_index) VALUES ($1,'ACTIVE',$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [rows[0].id, lower(event.transactionHash), event.blockNumber, lower(event.blockHash), event.logIndex]);
        await client.query(`INSERT INTO transactions (chain_id, transaction_hash, to_address, transaction_type, status, block_number, block_hash, mined_at, updated_at) VALUES ($1,$2,$3,'LISTING_CREATE','CONFIRMED',$4,$5,now(),now()) ON CONFLICT (chain_id, transaction_hash) DO UPDATE SET to_address=EXCLUDED.to_address, status=CASE WHEN transactions.status IN ('FINALIZED','RECONCILED') THEN transactions.status ELSE 'CONFIRMED' END, block_number=EXCLUDED.block_number, block_hash=EXCLUDED.block_hash, mined_at=COALESCE(transactions.mined_at, now()), updated_at=now()`, [event.chainId, lower(event.transactionHash), address(event.marketplaceAddress, "marketplaceAddress"), event.blockNumber, lower(event.blockHash)]);
        return { duplicate: false, listing: rows[0], state: "ACTIVE" };
      }

      const listingResult = await client.query(`SELECT l.*, mc.address AS marketplace_address, tc.address AS token_contract_address FROM listings l JOIN contracts mc ON mc.id=l.marketplace_contract_id JOIN contracts tc ON tc.id=l.token_contract_id WHERE l.chain_id=$1 AND mc.address=$2 AND l.listing_id=$3 FOR UPDATE`, [event.chainId, address(event.marketplaceAddress, "marketplaceAddress"), event.listingId]);
      const listing = listingResult.rows[0];
      if (!listing) throw new Error("Marketplace lifecycle event references an unknown listing.");

      if (event.eventType === "ListingCancelled" || event.eventType === "ListingExpired") {
        const status = event.eventType === "ListingCancelled" ? "CANCELLED" : "EXPIRED";
        const { rows } = await client.query(`UPDATE listings SET status=$2, updated_at=now() WHERE id=$1 AND status IN ('ACTIVE','PENDING','REORGED') RETURNING *`, [listing.id, status]);
        if (!rows[0] && listing.status !== status) throw new Error("Listing lifecycle event conflicts with persisted terminal state.");
        await client.query(`INSERT INTO listing_status_history (listing_id, status, transaction_hash, block_number, block_hash, log_index) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [listing.id, status, lower(event.transactionHash), event.blockNumber, lower(event.blockHash), event.logIndex]);
        await client.query(`INSERT INTO transactions (chain_id, transaction_hash, to_address, transaction_type, status, block_number, block_hash, mined_at, updated_at) VALUES ($1,$2,$3,'LISTING_CANCEL','CONFIRMED',$4,$5,now(),now()) ON CONFLICT (chain_id, transaction_hash) DO UPDATE SET status=CASE WHEN transactions.status IN ('FINALIZED','RECONCILED') THEN transactions.status ELSE 'CONFIRMED' END, block_number=EXCLUDED.block_number, block_hash=EXCLUDED.block_hash, mined_at=COALESCE(transactions.mined_at, now()), updated_at=now()`, [event.chainId, lower(event.transactionHash), address(event.marketplaceAddress, "marketplaceAddress"), event.blockNumber, lower(event.blockHash)]);
        return { duplicate: false, listing: rows[0] || listing, state: status };
      }

      if (listing.seller_wallet !== address(event.sellerWallet, "sellerWallet") || listing.token_contract_address !== address(event.tokenContractAddress, "tokenContractAddress") || String(listing.token_id) !== numeric(event.tokenId, "tokenId") || listing.currency !== "native") throw new Error("ListingSold event does not match the indexed listing identity.");
      const quantity = BigInt(numeric(event.quantity, "quantity", { positive: true }));
      const remaining = BigInt(listing.remaining_amount) - quantity;
      const expectedPrice = BigInt(listing.price_wei) * quantity;
      if (remaining < 0n || expectedPrice !== BigInt(event.salePriceWei)) throw new Error("ListingSold event quantity or price does not match the indexed listing.");
      if (BigInt(event.platformFeeWei) + BigInt(event.royaltyWei) > BigInt(event.salePriceWei)) throw new Error("ListingSold fee allocation exceeds the sale price.");
      const nextStatus = remaining === 0n ? "SOLD" : "ACTIVE";
      const { rows } = await client.query(`UPDATE listings SET remaining_amount=$2, status=$3, updated_at=now() WHERE id=$1 AND status='ACTIVE' RETURNING *`, [listing.id, remaining.toString(), nextStatus]);
      if (!rows[0]) throw new Error("ListingSold event cannot transition a non-active listing.");
      const transaction = await client.query(`INSERT INTO transactions (chain_id, transaction_hash, from_wallet, to_address, transaction_type, status, block_number, block_hash, value_wei, mined_at, updated_at) VALUES ($1,$2,$3,$4,'PURCHASE','CONFIRMED',$5,$6,$7,now(),now()) ON CONFLICT (chain_id, transaction_hash) DO UPDATE SET from_wallet=EXCLUDED.from_wallet, to_address=EXCLUDED.to_address, status=CASE WHEN transactions.status IN ('FINALIZED','RECONCILED') THEN transactions.status ELSE 'CONFIRMED' END, block_number=EXCLUDED.block_number, block_hash=EXCLUDED.block_hash, value_wei=EXCLUDED.value_wei, mined_at=COALESCE(transactions.mined_at, now()), updated_at=now() RETURNING *`, [event.chainId, lower(event.transactionHash), address(event.buyerWallet, "buyerWallet"), address(event.marketplaceAddress, "marketplaceAddress"), event.blockNumber, lower(event.blockHash), numeric(event.salePriceWei, "salePriceWei", { positive: true })]);
      const purchase = await client.query(`INSERT INTO purchases (listing_id, transaction_id, chain_id, transaction_hash, settlement_log_index, buyer_wallet, seller_wallet, token_contract_address, token_id, quantity, sale_price_wei, platform_fee_wei, royalty_wei, block_number, block_hash, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'CONFIRMED') ON CONFLICT (chain_id, transaction_hash, settlement_log_index) DO UPDATE SET status=CASE WHEN purchases.status IN ('FINALIZED','RECONCILED') THEN purchases.status ELSE 'CONFIRMED' END RETURNING *`, [listing.id, transaction.rows[0].id, event.chainId, lower(event.transactionHash), event.logIndex, address(event.buyerWallet, "buyerWallet"), address(event.sellerWallet, "sellerWallet"), address(event.tokenContractAddress, "tokenContractAddress"), numeric(event.tokenId, "tokenId"), quantity.toString(), numeric(event.salePriceWei, "salePriceWei", { positive: true }), numeric(event.platformFeeWei, "platformFeeWei"), numeric(event.royaltyWei, "royaltyWei"), event.blockNumber, lower(event.blockHash)]);
      await client.query(`INSERT INTO listing_status_history (listing_id, status, transaction_hash, block_number, block_hash, log_index) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [listing.id, nextStatus, lower(event.transactionHash), event.blockNumber, lower(event.blockHash), event.logIndex]);
      return { duplicate: false, listing: rows[0], purchase: purchase.rows[0], state: nextStatus };
    });
  }

  async reconcileMarketplaceListing({ chainId, marketplaceAddress, listingId, snapshot, blockTag }) {
    return withTransaction(this.db, async (client) => {
      const { rows } = await client.query(`SELECT l.*, mc.address AS marketplace_address, tc.address AS token_contract_address FROM listings l JOIN contracts mc ON mc.id=l.marketplace_contract_id JOIN contracts tc ON tc.id=l.token_contract_id WHERE l.chain_id=$1 AND mc.address=$2 AND l.listing_id=$3 FOR UPDATE`, [chainId, address(marketplaceAddress, "marketplaceAddress"), numeric(listingId, "listingId", { positive: true })]);
      const listing = rows[0];
      if (!listing) return { state: "MISSING", repaired: false };
      if (!snapshot) {
        const updated = await client.query("UPDATE listings SET status='INVALID', updated_at=now() WHERE id=$1 AND status NOT IN ('SOLD','CANCELLED','EXPIRED') RETURNING *", [listing.id]);
        return { state: "INVALID", repaired: Boolean(updated.rows[0]), listing: updated.rows[0] || listing };
      }
      const identityMatches = listing.seller_wallet === address(snapshot.sellerWallet, "snapshot.sellerWallet") && listing.token_contract_address === address(snapshot.tokenContractAddress, "snapshot.tokenContractAddress") && String(listing.token_id) === numeric(snapshot.tokenId, "snapshot.tokenId") && listing.currency === snapshot.currency;
      const quantitativelyValid = BigInt(snapshot.remainingAmount) <= BigInt(listing.amount) && BigInt(snapshot.remainingAmount) >= 0n && BigInt(snapshot.priceWei) > 0n;
      if (!identityMatches || !quantitativelyValid) {
        const updated = await client.query("UPDATE listings SET status='INVALID', updated_at=now() WHERE id=$1 AND status NOT IN ('SOLD','CANCELLED','EXPIRED') RETURNING *", [listing.id]);
        await client.query("INSERT INTO indexer_errors (chain_id, contract_address, error_type, message, payload) VALUES ($1,$2,'MARKETPLACE_LISTING_MISMATCH',$3,$4)", [chainId, address(marketplaceAddress), "Indexed listing differs from canonical marketplace state.", { listingId: String(listingId), snapshot }]);
        return { state: "INVALID", repaired: Boolean(updated.rows[0]), listing: updated.rows[0] || listing };
      }
      const isElapsed = snapshot.status === "ACTIVE" && snapshot.expiresAt && new Date(snapshot.expiresAt).getTime() <= Date.now();
      const status = isElapsed ? "EXPIRED" : snapshot.status;
      const update = await client.query(`UPDATE listings SET remaining_amount=$2, price_wei=$3, expires_at=$4, status=$5, updated_at=now() WHERE id=$1 AND (remaining_amount <> $2::numeric OR price_wei <> $3::numeric OR expires_at IS DISTINCT FROM $4 OR status <> $5) RETURNING *`, [listing.id, numeric(snapshot.remainingAmount, "snapshot.remainingAmount"), numeric(snapshot.priceWei, "snapshot.priceWei", { positive: true }), snapshot.expiresAt, status]);
      if (update.rows[0]) await client.query(`INSERT INTO listing_status_history (listing_id, status, transaction_hash, block_number, block_hash, log_index) VALUES ($1,$2,NULL,NULL,NULL,NULL) ON CONFLICT DO NOTHING`, [listing.id, status]);
      const reconciledPurchases = await client.query(`UPDATE purchases SET status='RECONCILED', finalized_at=COALESCE(finalized_at, now()), reconciled_at=now() WHERE listing_id=$1 AND status IN ('CONFIRMED','FINALIZED') RETURNING id`, [listing.id]);
      if (reconciledPurchases.rows.length) await client.query(`UPDATE transactions SET status='RECONCILED', finalized_at=now(), updated_at=now() WHERE id IN (SELECT transaction_id FROM purchases WHERE id = ANY($1::uuid[])) AND status IN ('CONFIRMED','FINALIZED')`, [reconciledPurchases.rows.map((purchase) => purchase.id)]);
      return { state: status, repaired: Boolean(update.rows[0]), reconciledPurchases: reconciledPurchases.rows.length, listing: update.rows[0] || listing, blockTag };
    });
  }

  async reconcileMarketplaceTransaction({ chainId, transactionHash, state, receipt }) {
    return withTransaction(this.db, async (client) => {
      const hash = lower(transactionHash);
      const { rows } = await client.query(`UPDATE transactions SET status=$3, block_number=COALESCE($4, block_number), block_hash=COALESCE($5, block_hash), mined_at=CASE WHEN $3 IN ('CONFIRMED','FINALIZED','RECONCILED') THEN COALESCE(mined_at, now()) ELSE mined_at END, finalized_at=CASE WHEN $3 IN ('FINALIZED','RECONCILED') THEN now() ELSE finalized_at END, updated_at=now() WHERE chain_id=$1 AND transaction_hash=$2 RETURNING *`, [chainId, hash, state, receipt?.blockNumber ?? null, receipt?.blockHash ? lower(receipt.blockHash) : null]);
      if (!rows[0]) return { state: "MISSING", transaction: null };
      if (state === "FAILED") await client.query("UPDATE purchases SET status='FAILED', reconciled_at=now() WHERE chain_id=$1 AND transaction_hash=$2 AND status IN ('PENDING','SUBMITTED')", [chainId, hash]);
      if (state === "FINALIZED") await client.query("UPDATE purchases SET status='FINALIZED', finalized_at=now(), reconciled_at=now() WHERE chain_id=$1 AND transaction_hash=$2 AND status='CONFIRMED'", [chainId, hash]);
      return { state, transaction: rows[0] };
    });
  }

  async adjustOwnership(client, { chainId, contractAddress, tokenId, wallet, delta, blockNumber, blockHash, watermark }) {
    const current = await client.query("SELECT amount FROM ownership_snapshots WHERE chain_id=$1 AND contract_address=$2 AND token_id=$3 AND wallet_address=$4 FOR UPDATE", [chainId, lower(contractAddress), tokenId, lower(wallet)]);
    const previous = BigInt(current.rows[0]?.amount || 0);
    const next = previous + delta;
    if (next < 0n) throw new Error("Indexed ownership would become negative; reconciliation is required.");
    await client.query(`INSERT INTO ownership_snapshots (chain_id, contract_address, token_id, wallet_address, amount, source_block_number, source_block_hash, synchronization_watermark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (chain_id, contract_address, token_id, wallet_address) DO UPDATE SET amount=EXCLUDED.amount, source_block_number=EXCLUDED.source_block_number, source_block_hash=EXCLUDED.source_block_hash, synchronization_watermark=EXCLUDED.synchronization_watermark, updated_at=now()`, [chainId, lower(contractAddress), tokenId, lower(wallet), next.toString(), blockNumber, lower(blockHash), watermark]);
    await client.query(`INSERT INTO collectors (wallet_address) VALUES ($1) ON CONFLICT (wallet_address) DO UPDATE SET last_seen_at=now()`, [lower(wallet)]);
  }

  async recordIndexerError({ chainId, contractAddress = null, blockNumber = null, transactionHash = null, logIndex = null, errorType, message, payload = {} }) {
    await this.db.query("INSERT INTO indexer_errors (chain_id, contract_address, block_number, transaction_hash, log_index, error_type, message, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [chainId, contractAddress ? lower(contractAddress) : null, blockNumber, transactionHash ? lower(transactionHash) : null, logIndex, errorType, message, payload]);
  }

  async getOwnership({ chainId, contractAddress, tokenId, wallet }) {
    const { rows } = await this.db.query("SELECT * FROM ownership_snapshots WHERE chain_id=$1 AND contract_address=$2 AND token_id=$3 AND wallet_address=$4 AND synchronization_watermark <> 'REORG_PENDING'", [chainId, lower(contractAddress), tokenId, lower(wallet)]);
    return rows[0] || null;
  }

  async listOwnershipReconciliationTargets({ chainId, contractAddress }) {
    const { rows } = await this.db.query(`SELECT DISTINCT token_id, wallet_address FROM (SELECT token_id, wallet_address FROM ownership_snapshots WHERE chain_id=$1 AND contract_address=$2 UNION SELECT token_id, to_wallet AS wallet_address FROM transfers WHERE chain_id=$1 AND contract_address=$2 AND is_canonical=true AND to_wallet <> '0x0000000000000000000000000000000000000000' UNION SELECT token_id, from_wallet AS wallet_address FROM transfers WHERE chain_id=$1 AND contract_address=$2 AND is_canonical=true AND from_wallet <> '0x0000000000000000000000000000000000000000') targets ORDER BY token_id, wallet_address`, [chainId, lower(contractAddress)]);
    return rows;
  }

  async reconcileOwnership({ chainId, contractAddress, wallet, tokenId, amount, sourceBlock = null, watermark = "RECONCILED" }) {
    const blockNumber = sourceBlock?.number ?? null;
    const blockHash = sourceBlock?.hash ? lower(sourceBlock.hash) : null;
    const { rows } = await this.db.query(`INSERT INTO ownership_snapshots (chain_id, contract_address, token_id, wallet_address, amount, source_block_number, source_block_hash, synchronization_watermark) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (chain_id, contract_address, token_id, wallet_address) DO UPDATE SET amount=EXCLUDED.amount, source_block_number=COALESCE(EXCLUDED.source_block_number, ownership_snapshots.source_block_number), source_block_hash=COALESCE(EXCLUDED.source_block_hash, ownership_snapshots.source_block_hash), synchronization_watermark=EXCLUDED.synchronization_watermark, updated_at=now() RETURNING *`, [chainId, lower(contractAddress), numeric(tokenId, "tokenId"), lower(wallet), numeric(amount, "amount"), blockNumber, blockHash, watermark]);
    await this.db.query("INSERT INTO collectors (wallet_address) VALUES ($1) ON CONFLICT (wallet_address) DO UPDATE SET last_seen_at=now()", [lower(wallet)]);
    return rows[0];
  }
}

export function createIndexerStore(db) { return new IndexerStore(db); }
