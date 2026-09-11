import process from "node:process";
import { loadServerConfig } from "./config.js";
import { createApiServer } from "./index.js";
import { migrate } from "./migrate.js";
import { createIndexerWorker } from "./indexer-worker.js";
import { applyFujiRuntimeDefaults } from "./fuji-defaults.js";

let boot = null;

function pathOf(request) {
  try { return new URL(request.url || "/", "http://localhost").pathname; } catch { return request.url || "/"; }
}

export function createVercelHandler({ env = process.env, logger = console } = {}) {
  applyFujiRuntimeDefaults(env);
  const config = loadServerConfig(env, { allowMissingDatabase: true });
  const { handler, pool } = createApiServer({ config, logger });
  let migrated = null;
  let worker = null;

  async function ensureMigrated() {
    if (!config.databaseUrl || !pool) return { skipped: true, reason: "database_not_configured" };
    if (!migrated) migrated = migrate({ pool, config }).catch((error) => { migrated = null; throw error; });
    return migrated;
  }

  async function tickIndexer() {
    if (!config.databaseUrl || !pool) return { skipped: true, reason: "database_not_configured" };
    if (!config.indexer.contracts.length) return { skipped: true, reason: "indexer_contracts_not_configured" };
    if (!worker) worker = createIndexerWorker({ config, pool, logger });
    const result = await worker.syncOnce();
    return { skipped: false, result };
  }

  return async function handle(request, response) {
    const pathname = pathOf(request);
    const indexerTick = pathname === "/api/indexer/tick" || pathname === "/indexer/tick";
    try {
      if (config.databaseUrl) await ensureMigrated();
      if (indexerTick && (request.method === "GET" || request.method === "POST")) {
        const data = await tickIndexer();
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ data }));
        return;
      }
      return handler(request, response);
    } catch (error) {
      logger.error?.("api.vercel.error", { error: error.message, path: pathname });
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: { code: "INTERNAL", message: error.message } }));
      }
    }
  };
}

export function getVercelHandler() {
  if (!boot) boot = createVercelHandler();
  return boot;
}
