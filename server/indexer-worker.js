import process from "node:process";
import { createDatabasePool, closeDatabasePool } from "./db.js";
import { loadServerConfig } from "./config.js";
import { createIndexerStore } from "./indexer-store.js";
import { BlockchainIndexer } from "./indexer.js";
import { createJsonRpcClient } from "./indexer-rpc.js";

export function createIndexerWorker({ config = loadServerConfig(), pool = null, logger = console, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!config.indexer.rpcUrl || config.indexer.chainId !== 43113 || config.indexer.contracts.length === 0) throw new Error("Fuji indexer requires INDEXER_RPC_URL, INDEXER_CHAIN_ID=43113, and INDEXER_CONTRACTS_JSON.");
  const ownPool = pool || createDatabasePool(config);
  const rpc = createJsonRpcClient({ url: config.indexer.rpcUrl });
  const store = createIndexerStore(ownPool);
  const indexer = new BlockchainIndexer({ rpc, store, configs: config.indexer.contracts.map((contract) => ({ ...contract, chainId: config.indexer.chainId, confirmations: config.indexer.confirmations })), confirmations: config.indexer.confirmations, logger });
  let stopped = false;
  let running = false;
  async function syncOnce() { if (running || stopped) return null; running = true; try { return await indexer.syncAll(); } finally { running = false; } }
  async function run() { while (!stopped) { try { await syncOnce(); } catch (error) { logger.error?.("indexer.worker.failed", { error: error.message }); } if (!stopped) await sleep(config.indexer.pollIntervalMs); } }
  async function stop() { stopped = true; while (running) await sleep(25); if (!pool) await closeDatabasePool(ownPool); }
  return { indexer, syncOnce, run, stop };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const worker = createIndexerWorker();
  const shutdown = async (signal) => { console.log(JSON.stringify({ event: "indexer.worker.stopping", signal })); await worker.stop(); process.exit(0); };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
  worker.run().catch((error) => { console.error(JSON.stringify({ event: "indexer.worker.fatal", error: error.message })); process.exitCode = 1; });
}
