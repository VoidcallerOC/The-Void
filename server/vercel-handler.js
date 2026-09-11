import process from "node:process";
import { loadServerConfig } from "./config.js";
import { createApiServer } from "./index.js";
import { migrate } from "./migrate.js";
import { createIndexerWorker } from "./indexer-worker.js";
import { applyFujiRuntimeDefaults } from "./fuji-defaults.js";

let boot = null;

const GATEWAY_PATHS = new Set(["/api/gateway", "/api/[...path]", "/api/ready", "/api/index"]);

function header(request, name) {
  const headers = request.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
}

export function forceVercelPath(request, pathname) {
  try {
    const url = new URL(request.url || pathname, "http://localhost");
    url.pathname = pathname;
    request.url = `${url.pathname}${url.search}`;
  } catch {
    request.url = pathname;
  }
  return request;
}

export function resolveVercelApiPath(request) {
  let pathname = "/";
  try {
    pathname = new URL(request.url || "/", "http://localhost").pathname;
  } catch {
    pathname = String(request.url || "/").split("?")[0] || "/";
  }

  const forwarded = header(request, "x-forwarded-uri") || header(request, "x-invoke-path");
  if (typeof forwarded === "string") {
    const forwardedPath = forwarded.split("?")[0];
    if (forwardedPath.startsWith("/api/") && !GATEWAY_PATHS.has(forwardedPath)) return forwardedPath;
  }

  if (pathname.startsWith("/api/") && !GATEWAY_PATHS.has(pathname)) return pathname;

  const splat = request.query?.path ?? request.query?.["...path"];
  if (splat != null && splat !== "") {
    const rest = Array.isArray(splat) ? splat.filter(Boolean).join("/") : String(splat).replace(/^\//, "");
    return `/api/${rest}`.replace(/\/{2,}/g, "/");
  }

  return pathname;
}

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
    forceVercelPath(request, resolveVercelApiPath(request));
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
