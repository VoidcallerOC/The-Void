import { checkDatabaseHealth } from "./db.js";
import { createJsonRpcClient } from "./indexer-rpc.js";

export function createReadinessChecker({ pool, config, rpc = null, now = () => Date.now() } = {}) {
  const rpcClient = rpc || (config?.indexer?.rpcUrl ? createJsonRpcClient({ url: config.indexer.rpcUrl }) : null);
  return async function checkReadiness() {
    let database = { ok: false, error: "DATABASE_URL is not configured." };
    if (pool) {
      database = await checkDatabaseHealth(pool);
      if (database.ok) {
        try { await pool.query("SELECT name FROM schema_migrations ORDER BY name LIMIT 1"); database.migrations = { ok: true }; } catch (error) { database.migrations = { ok: false, error: error.message }; database.ok = false; }
      }
    }
    const marketplace = config?.marketplace?.enabled
      ? { configured: true, status: "configured", address: config.marketplace.address, chainId: config.marketplace.chainId }
      : { configured: false, status: "not_configured", address: null, chainId: null };
    let indexer = { ok: false, configured: Boolean(config?.indexer?.rpcUrl && config?.indexer?.chainId), chainId: config?.indexer?.chainId || null, latestBlock: null, finalizedBlock: null, checkpoint: null, lag: null, error: null };
    if (indexer.configured && rpcClient) {
      try {
        const latestBlock = await rpcClient.getBlockNumber();
        if (!pool) {
          indexer = { ...indexer, latestBlock, error: "DATABASE_URL is not configured." };
        } else {
          const result = await pool.query("SELECT MAX(finalized_block) AS finalized_block, MAX(last_processed_block) AS last_processed_block, MAX(updated_at) AS updated_at FROM indexer_checkpoints WHERE chain_id=$1", [config.indexer.chainId]);
          const row = result.rows[0] || {};
          const finalizedBlock = row.finalized_block === null ? null : Number(row.finalized_block);
          const lastProcessedBlock = row.last_processed_block === null ? null : Number(row.last_processed_block);
          const lag = lastProcessedBlock === null ? null : Math.max(0, latestBlock - lastProcessedBlock);
          indexer = { ...indexer, ok: finalizedBlock !== null && lag !== null, latestBlock, finalizedBlock, lastProcessedBlock, checkpointUpdatedAt: row.updated_at || null, lag, stale: row.updated_at ? now() - new Date(row.updated_at).getTime() > config.indexer.pollIntervalMs * 4 : true };
        }
      } catch (error) { indexer = { ...indexer, error: error.message }; }
    }
    const ok = database.ok && indexer.ok && !indexer.stale;
    return { ok, status: ok ? "ready" : "not_ready", database, marketplace, rpc: { ok: indexer.error === null && indexer.configured, chainId: indexer.chainId, latestBlock: indexer.latestBlock, error: indexer.error }, indexer };
  };
}
