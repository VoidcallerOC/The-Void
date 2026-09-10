import process from "node:process";

export class ConfigurationError extends Error {
  constructor(message) { super(message); this.name = "ConfigurationError"; }
}

function positiveInteger(value, fallback) { const parsed = Number(value ?? fallback); return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback; }
function requiredUrl(env, key, { production = false } = {}) { const value = String(env[key] || "").trim(); if (!value && !production) return null; try { return new URL(value).toString().replace(/\/$/, ""); } catch { throw new ConfigurationError(`${key} must be a valid URL.`); } }
function listValue(value) { return String(value || "").split(",").map((item) => item.trim()).filter(Boolean); }
function parseContracts(value, { production = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) { if (production) throw new ConfigurationError("INDEXER_CONTRACTS_JSON is required in production."); return []; }
  let parsed; try { parsed = JSON.parse(raw); } catch { throw new ConfigurationError("INDEXER_CONTRACTS_JSON must be valid JSON."); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new ConfigurationError("INDEXER_CONTRACTS_JSON must be a non-empty array.");
  return parsed.map((contract, index) => { if (!/^0x[a-fA-F0-9]{40}$/.test(String(contract.address || ""))) throw new ConfigurationError(`INDEXER_CONTRACTS_JSON[${index}].address is invalid.`); if (!Number.isInteger(Number(contract.startBlock)) || Number(contract.startBlock) < 0) throw new ConfigurationError(`INDEXER_CONTRACTS_JSON[${index}].startBlock is invalid.`); return Object.freeze({ ...contract, address: contract.address.toLowerCase(), startBlock: Number(contract.startBlock) }); });
}

export function loadServerConfig(env = process.env, { allowMissingDatabase = false } = {}) {
  const databaseUrl = String(env.DATABASE_URL || "").trim();
  if (!databaseUrl && !allowMissingDatabase) throw new ConfigurationError("DATABASE_URL is required for the persistence layer.");
  const appEnvironment = String(env.NODE_ENV || "development");
  const production = appEnvironment === "production";
  const marketplaceAddress = String(env.MARKETPLACE_ADDRESS || "").trim().toLowerCase();
  const marketplaceChainId = Number(env.MARKETPLACE_CHAIN_ID || 0);
  const marketplaceEnabled = /^0x[a-f0-9]{40}$/.test(marketplaceAddress) && Number.isInteger(marketplaceChainId) && marketplaceChainId > 0;
  if (production && !marketplaceEnabled) throw new ConfigurationError("MARKETPLACE_ADDRESS and MARKETPLACE_CHAIN_ID are required in production.");
  const indexerRpcUrl = requiredUrl(env, "INDEXER_RPC_URL", { production });
  const indexerChainId = Number(env.INDEXER_CHAIN_ID || 0);
  if (indexerRpcUrl && indexerChainId !== 43113) throw new ConfigurationError("Fuji staging requires INDEXER_CHAIN_ID=43113.");
  const authDomain = requiredUrl(env, "AUTH_DOMAIN", { production });
  const authUri = requiredUrl(env, "AUTH_URI", { production });
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
    allowedOrigins,
    marketplace: Object.freeze({ address: marketplaceEnabled ? marketplaceAddress : null, chainId: marketplaceEnabled ? marketplaceChainId : null, enabled: marketplaceEnabled }),
    indexer: Object.freeze({ rpcUrl: indexerRpcUrl, chainId: indexerChainId || null, confirmations: Math.max(0, positiveInteger(env.INDEXER_CONFIRMATIONS, 12)), pollIntervalMs: Math.max(1000, positiveInteger(env.INDEXER_POLL_INTERVAL_MS, 15000)), contracts: parseContracts(env.INDEXER_CONTRACTS_JSON, { production }) }),
  });
}
