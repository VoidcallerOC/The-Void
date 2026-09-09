import { withTransaction } from "./db.js";
import { normalizeBlockTimestamp } from "./indexer-utils.js";

function lower(value) { return String(value || "").toLowerCase(); }

export class IndexerStore {
  constructor(db) { if (!db?.query) throw new TypeError("IndexerStore requires a database executor."); this.db = db; }

  async getCheckpoint({ chainId, address }) {
    const { rows } = await this.db.query("SELECT * FROM indexer_checkpoints WHERE chain_id=$1 AND contract_address=$2", [chainId, lower(address)]);
    return rows[0] || null;
  }

  async setCheckpoint({ chainId, address, contractType, nextBlock, lastProcessedBlock = null, lastProcessedHash = null, finalizedBlock = null, status = "IDLE", lastError = null }) {
    const { rows } = await this.db.query(`INSERT INTO indexer_checkpoints (chain_id, contract_address, contract_type, next_block, last_processed_block, last_processed_hash, finalized_block, status, last_error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (chain_id, contract_address) DO UPDATE SET contract_type=EXCLUDED.contract_type, next_block=EXCLUDED.next_block, last_processed_block=EXCLUDED.last_processed_block, last_processed_hash=EXCLUDED.last_processed_hash, finalized_block=EXCLUDED.finalized_block, status=EXCLUDED.status, last_error=EXCLUDED.last_error, updated_at=now() RETURNING *`, [chainId, lower(address), contractType, nextBlock, lastProcessedBlock, lastProcessedHash, finalizedBlock, status, lastError]);
    return rows[0];
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
      return { chainId, fromBlock, replacementHash };
    });
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
    const { rows } = await this.db.query("SELECT * FROM ownership_snapshots WHERE chain_id=$1 AND contract_address=$2 AND token_id=$3 AND wallet_address=$4", [chainId, lower(contractAddress), tokenId, lower(wallet)]);
    return rows[0] || null;
  }
}

export function createIndexerStore(db) { return new IndexerStore(db); }
