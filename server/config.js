import process from "node:process";

export class ConfigurationError extends Error {
  constructor(message) { super(message); this.name = "ConfigurationError"; }
}

function positiveInteger(value, fallback) { const parsed = Number(value ?? fallback); return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback; }
function requiredUrl(env, key, { production = false } = {}) { const value = String(env[key] || "").trim(); if (!value && !production) return null; try { return new URL(value).toString().replace(/\/$/, ""); } catch { throw new ConfigurationError(`${key} must be a valid URL.`); } }
function listValue(value) { return String(value || "").split(",").map((item) => item.trim()).filter(Boolean); }
function parseContracts(value, { production = false, required = production } = {}) {
  const raw = String(value || "").trim();
  if (!raw) { if (required) throw new ConfigurationError("INDEXER_CONTRACTS_JSON is required for the indexer worker."); return []; }
  let parsed; try { parsed = JSON.parse(raw); } catch { throw new ConfigurationError("INDEXER_CONTRACTS_JSON must be valid JSON."); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new ConfigurationError("INDEXER_CONTRACTS_JSON must be a non-empty array.");
  return parsed.map((contract, index) => { if (!/^0x[a-fA-F0-9]{40}$/.test(String(contract.address || ""))) throw new ConfigurationError(`INDEXER_CONTRACTS_JSON[${index}].address is invalid.`); if (!Number.isInteger(Number(contract.startBlock)) || Number(contract.startBlock) < 0) throw new ConfigurationError(`INDEXER_CONTRACTS_JSON[${index}].startBlock is invalid.`); return Object.freeze({ ...contract, address: contract.address.toLowerCase(), startBlock: Number(contract.startBlock) }); });
}

function parseMarketplace(env) {
  const rawAddress = String(env.MARKETPLACE_ADDRESS || "").trim();
  const rawChainId = String(env.MARKETPLACE_CHAIN_ID || "").trim();
  if (!rawAddress && !rawChainId) return Object.freeze({ address: null, chainId: null, enabled: false, status: "not_configured" });
  if (!/^0x[a-fA-F0-9]{40}$/.test(rawAddress)) throw new ConfigurationError("MARKETPLACE_ADDRESS must be a valid EVM address when marketplace functionality is configured.");
  const chainId = Number(rawChainId);
  if (!Number.isInteger(chainId) || chainId !== 43113) throw new ConfigurationError("Fuji marketplace configuration requires MARKETPLACE_CHAIN_ID=43113.");
  return Object.freeze({ address: rawAddress.toLowerCase(), chainId, enabled: true, status: "configured" });
}

export function loadServerConfig(env = process.env, { allowMissingDatabase = false, requireIndexerContracts = false } = {}) {
  const databaseUrl = String(env.DATABASE_URL || "").trim();
  if (!databaseUrl && !allowMissingDatabase) throw new ConfigurationError("DATABASE_URL is required for the persistence layer.");
  const appEnvironment = String(env.NODE_ENV || "development");
  const production = appEnvironment === "production";
  const marketplace = parseMarketplace(env);
  const indexerRpcUrl = requiredUrl(env, "INDEXER_RPC_URL", { production });
  const indexerChainId = Number(env.INDEXER_CHAIN_ID || 0);
  if (indexerRpcUrl && indexerChainId !== 43113) throw new ConfigurationError("Fuji staging requires INDEXER_CHAIN_ID=43113.");
  const authDomain = requiredUrl(env, "AUTH_DOMAIN", { production });
  const authUri = requiredUrl(env, "AUTH_URI", { production });
  const authChainId = Number(env.AUTH_CHAIN_ID || (production ? 43114 : 43113));
  if (![43113, 43114].includes(authChainId)) throw new ConfigurationError("AUTH_CHAIN_ID must be Avalanche Fuji (43113) or Avalanche C-Chain (43114).");
  const allowedOrigins = listValue(env.API_ALLOWED_ORIGINS);
  if (production && allowedOrigins.length === 0) throw new ConfigurationError("API_ALLOWED_ORIGINS is required in production.");
  return Object.freeze({
    databaseUrl: databaseUrl || null,
    databaseSsl: String(env.DATABASE_SSL || "true").toLowerCase() !== "false",
    poolMax: Math.max(1, positiveInteger(env.DATABASE_POOL_MAX, 10)),
    poolIdleTimeoutMs: Math.max(1, positiveInteger(env.DATABASE_POOL_IDLE_TIMEOUT_MS, 30000)),
    poolConnectionTimeoutMs: Math.max(1, positiveInteger(env.DATABASE_POOL_CONNECTION_TIMEOUT_MS, 5000)),
    appEnvironment,
    publicAppUrl: requiredUrl(env, "PUBLIC_APP_URL", { production }) || "http://localhost:5173",
    authDomain,
    authUri,
    authChainId,
    allowedOrigins,
    marketplace,
    indexer: Object.freeze({ rpcUrl: indexerRpcUrl, chainId: indexerChainId || null, confirmations: Math.max(0, positiveInteger(env.INDEXER_CONFIRMATIONS, 12)), pollIntervalMs: Math.max(1000, positiveInteger(env.INDEXER_POLL_INTERVAL_MS, 15000)), contracts: parseContracts(env.INDEXER_CONTRACTS_JSON, { production, required: requireIndexerContracts }) }),
  });
}
