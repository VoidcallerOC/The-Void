import process from "node:process";
import { resolve } from "node:path";
import { id } from "ethers";

const AVALANCHE_AUTH_CHAIN_IDS = new Set([43113, 43114]);
const PLACEHOLDER_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000001";
const ERC1155_EVENT_TOPICS = Object.freeze({
  TransferSingle: id("TransferSingle(address,address,address,uint256,uint256)"),
  TransferBatch: id("TransferBatch(address,address,address,uint256[],uint256[])")
});

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedPositiveInteger(value, fallback, name, { min, max }) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new ConfigurationError(`${name} must be an integer between ${min} and ${max}.`);
  return parsed;
}

function normalizedUrl(value, name) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error();
    return parsed;
  } catch {
    throw new ConfigurationError(`${name} must be an absolute HTTP(S) URL without credentials or a fragment.`);
  }
}

function allowedChainIds(value, fallback) {
  const ids = String(value ?? fallback).split(",").map((entry) => Number(entry.trim())).filter((entry) => Number.isSafeInteger(entry) && entry > 0);
  if (!ids.length || new Set(ids).size !== ids.length) throw new ConfigurationError("AUTH_ALLOWED_CHAIN_IDS must be a comma-separated set of positive chain IDs.");
  if (ids.some((entry) => !AVALANCHE_AUTH_CHAIN_IDS.has(entry))) throw new ConfigurationError("AUTH_ALLOWED_CHAIN_IDS may contain only Avalanche Fuji (43113) or C-Chain (43114).");
  return Object.freeze(ids);
}

function nonNegativeInteger(value, fallback, name, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (fallback === null && (value === undefined || value === null || String(value).trim() === "")) throw new ConfigurationError(`${name} is required.`);
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) throw new ConfigurationError(`${name} must be an integer between 0 and ${max}.`);
  return parsed;
}

function evmAddress(value, name) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new ConfigurationError(`${name} must be a 20-byte EVM address.`);
  return normalized;
}

function parseIndexerContracts(value, { chainId }) {
  let parsed;
  try { parsed = JSON.parse(String(value || "")); } catch { throw new ConfigurationError("INDEXER_CONTRACTS_JSON must be valid JSON."); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new ConfigurationError("INDEXER_CONTRACTS_JSON must contain at least one registered ERC1155 or MARKETPLACE contract.");
  const addresses = new Set();
  return Object.freeze(parsed.map((contract, index) => {
    if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new ConfigurationError(`INDEXER_CONTRACTS_JSON[${index}] must be an object.`);
    const address = evmAddress(contract.address, `INDEXER_CONTRACTS_JSON[${index}].address`);
    if (address === PLACEHOLDER_CONTRACT_ADDRESS) throw new ConfigurationError(`INDEXER_CONTRACTS_JSON[${index}].address may not use the placeholder contract address.`);
    if (addresses.has(address)) throw new ConfigurationError(`INDEXER_CONTRACTS_JSON contains duplicate address ${address}.`);
    addresses.add(address);
    const contractType = String(contract.contractType || "").trim().toUpperCase();
    if (contractType !== "ERC1155" && contractType !== "MARKETPLACE") throw new ConfigurationError(`INDEXER_CONTRACTS_JSON[${index}].contractType must be ERC1155 or MARKETPLACE.`);
    const declaredChainId = contract.chainId === undefined ? chainId : Number(contract.chainId);
    if (declaredChainId !== chainId) throw new ConfigurationError(`INDEXER_CONTRACTS_JSON[${index}].chainId must match INDEXER_CHAIN_ID.`);
    const startBlock = nonNegativeInteger(contract.startBlock, null, `INDEXER_CONTRACTS_JSON[${index}].startBlock`);
    const platformFeeBps = contract.platformFeeBps === undefined || contract.platformFeeBps === null ? null : nonNegativeInteger(contract.platformFeeBps, null, `INDEXER_CONTRACTS_JSON[${index}].platformFeeBps`, { max: 10_000 });
    return Object.freeze({ chainId, address, contractType, startBlock, platformFeeBps, reconcileListings: contract.reconcileListings !== false, eventTopics: contractType === "ERC1155" ? ERC1155_EVENT_TOPICS : undefined });
  }));
}

export function loadServerConfig(env = process.env, { allowMissingDatabase = false } = {}) {
  const databaseUrl = String(env.DATABASE_URL || env.POSTGRES_URL || "").trim();
  if (!databaseUrl && !allowMissingDatabase) throw new ConfigurationError("DATABASE_URL is required for the persistence layer.");
  const appEnvironment = String(env.NODE_ENV || "development").trim().toLowerCase();
  const publicApp = normalizedUrl(env.PUBLIC_APP_URL || "http://localhost:5173", "PUBLIC_APP_URL");
  const authUri = normalizedUrl(env.AUTH_URI || publicApp.toString(), "AUTH_URI");
  if (authUri.origin !== publicApp.origin) throw new ConfigurationError("AUTH_URI must share the PUBLIC_APP_URL origin.");
  const authDomain = String(env.AUTH_DOMAIN || publicApp.host).trim().toLowerCase();
  if (authDomain !== publicApp.host.toLowerCase()) throw new ConfigurationError("AUTH_DOMAIN must match the PUBLIC_APP_URL host.");
  const authAllowedChainIds = allowedChainIds(env.AUTH_ALLOWED_CHAIN_IDS, "43113");
  if (appEnvironment === "production" && (publicApp.protocol !== "https:" || authUri.protocol !== "https:" || authAllowedChainIds.length !== 1 || authAllowedChainIds[0] !== 43113)) {
    throw new ConfigurationError("Production wallet authentication requires HTTPS and Avalanche Fuji (43113) only.");
  }
  return Object.freeze({
    databaseUrl: databaseUrl || null,
    databaseSsl: String(env.DATABASE_SSL || "true").toLowerCase() !== "false",
    databaseSslRejectUnauthorized: String(env.DATABASE_SSL_REJECT_UNAUTHORIZED ?? (/([?&])sslmode=require(?:&|$)/i.test(databaseUrl) ? "false" : "true")).toLowerCase() !== "false",
    poolMax: positiveInteger(env.DATABASE_POOL_MAX, 10),
    poolIdleTimeoutMs: positiveInteger(env.DATABASE_POOL_IDLE_TIMEOUT_MS, 30000),
    poolConnectionTimeoutMs: positiveInteger(env.DATABASE_POOL_CONNECTION_TIMEOUT_MS, 5000),
    shutdownTimeoutMs: boundedPositiveInteger(env.APP_SHUTDOWN_TIMEOUT_MS, 15_000, "APP_SHUTDOWN_TIMEOUT_MS", { min: 1_000, max: 120_000 }),
    ownershipMaxIndexerLagBlocks: nonNegativeInteger(env.OWNERSHIP_MAX_INDEXER_LAG_BLOCKS, 24, "OWNERSHIP_MAX_INDEXER_LAG_BLOCKS", { max: 10_000 }),
    ownershipMaxIndexerStalenessMs: boundedPositiveInteger(env.OWNERSHIP_MAX_INDEXER_STALENESS_MS, 120_000, "OWNERSHIP_MAX_INDEXER_STALENESS_MS", { min: 1_000, max: 3_600_000 }),
    appEnvironment,
    publicAppUrl: publicApp.toString().replace(/\/$/, ""),
    authOrigin: publicApp.origin,
    authDomain,
    authUri: authUri.toString().replace(/\/$/, ""),
    apiAllowedOrigins: allowedOrigins(env.API_ALLOWED_ORIGINS, publicApp),
    authAllowedChainIds,
    authChallengeTtlSeconds: boundedPositiveInteger(env.AUTH_CHALLENGE_TTL_SECONDS, 300, "AUTH_CHALLENGE_TTL_SECONDS", { min: 60, max: 900 }),
    authSessionTtlSeconds: boundedPositiveInteger(env.AUTH_SESSION_TTL_SECONDS, 3600, "AUTH_SESSION_TTL_SECONDS", { min: 300, max: 86400 }),
  });
}

export function loadIndexerConfig(env = process.env, { requireConfiguration = true } = {}) {
  const appEnvironment = String(env.NODE_ENV || "development").trim().toLowerCase();
  const defaultChainId = 43113;
  const chainId = Number(env.INDEXER_CHAIN_ID || defaultChainId);
  if (!AVALANCHE_AUTH_CHAIN_IDS.has(chainId)) throw new ConfigurationError("INDEXER_CHAIN_ID may contain only Avalanche Fuji (43113) or C-Chain (43114).");
  if (appEnvironment === "production" && chainId !== 43113) throw new ConfigurationError("Production indexing requires Avalanche Fuji (43113).");
  const rpcUrlValue = String(env.INDEXER_RPC_URL || "").trim();
  const contractsValue = String(env.INDEXER_CONTRACTS_JSON || "").trim();
  if (!rpcUrlValue || !contractsValue) {
    if (!requireConfiguration) return null;
    throw new ConfigurationError("INDEXER_RPC_URL and INDEXER_CONTRACTS_JSON are required to run the indexer worker.");
  }
  const rpcTimeoutMs = boundedPositiveInteger(env.INDEXER_RPC_TIMEOUT_MS, 15_000, "INDEXER_RPC_TIMEOUT_MS", { min: 1_000, max: 120_000 });
  const rpcRetries = nonNegativeInteger(env.INDEXER_RPC_RETRIES, 4, "INDEXER_RPC_RETRIES", { max: 20 });
  const retryBaseDelayMs = boundedPositiveInteger(env.INDEXER_RETRY_BASE_DELAY_MS, 250, "INDEXER_RETRY_BASE_DELAY_MS", { min: 1, max: 60_000 });
  const leaseTtlMs = boundedPositiveInteger(env.INDEXER_LEASE_TTL_MS, 90_000, "INDEXER_LEASE_TTL_MS", { min: 10_000, max: 600_000 });
  const minimumLeaseTtlMs = ((rpcRetries + 1) * rpcTimeoutMs) + (retryBaseDelayMs * ((2 ** rpcRetries) - 1)) + 1_000;
  if (leaseTtlMs < minimumLeaseTtlMs) throw new ConfigurationError(`INDEXER_LEASE_TTL_MS must be at least ${minimumLeaseTtlMs} to cover the configured RPC retry window.`);
  return Object.freeze({
    chainId,
    rpcUrl: normalizedUrl(rpcUrlValue, "INDEXER_RPC_URL").toString(),
    contracts: parseIndexerContracts(contractsValue, { chainId }),
    confirmations: boundedPositiveInteger(env.INDEXER_CONFIRMATIONS, 12, "INDEXER_CONFIRMATIONS", { min: 1, max: 500 }),
    chunkSize: boundedPositiveInteger(env.INDEXER_CHUNK_SIZE, 500, "INDEXER_CHUNK_SIZE", { min: 1, max: 10_000 }),
    pollIntervalMs: boundedPositiveInteger(env.INDEXER_POLL_INTERVAL_MS, 15_000, "INDEXER_POLL_INTERVAL_MS", { min: 1_000, max: 300_000 }),
    rpcTimeoutMs,
    rpcRetries,
    retryBaseDelayMs,
    ownershipReconciliationIntervalMs: boundedPositiveInteger(env.INDEXER_OWNERSHIP_RECONCILIATION_INTERVAL_MS, 900_000, "INDEXER_OWNERSHIP_RECONCILIATION_INTERVAL_MS", { min: 60_000, max: 86_400_000 }),
    leaseTtlMs,
  });
}

function secret(value, name, { required = false } = {}) {
  const text = String(value || "").trim();
  if (required && text.length < 24) throw new ConfigurationError(`${name} must be configured with at least 24 characters.`);
  return text || null;
}

function hostAllowlist(value, name) {
  const hosts = String(value || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (!hosts.length || hosts.some((host) => !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(host))) throw new ConfigurationError(`${name} must contain one or more host[:port] entries.`);
  return Object.freeze([...new Set(hosts)]);
}

function protectedPrefixes(value, name) {
  const prefixes = String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!prefixes.length || prefixes.some((prefix) => prefix.startsWith("/") || prefix.includes("\\") || prefix.split("/").some((part) => !part || part === "." || part === ".."))) throw new ConfigurationError(`${name} must contain one or more safe object-key prefixes.`);
  return Object.freeze([...new Set(prefixes.map((prefix) => prefix.replace(/\/+$/, "")))]);
}

function allowedOrigins(value, publicApp) {
  const configured = String(value || "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const origins = [publicApp.origin, ...configured.map((entry) => normalizedUrl(entry, "API_ALLOWED_ORIGINS").origin)];
  return Object.freeze([...new Set(origins)]);
}

export function loadMediaConfig(env = process.env) {
  const appEnvironment = String(env.NODE_ENV || "development").trim().toLowerCase();
  const explicitDriver = String(env.MEDIA_STORAGE_DRIVER || "").trim().toLowerCase();
  const driver = explicitDriver || (appEnvironment === "production" ? "pinata" : "filesystem");
  if (driver !== "filesystem" && driver !== "pinata" && driver !== "object") throw new ConfigurationError("MEDIA_STORAGE_DRIVER must be filesystem, pinata, or object.");
  if (appEnvironment === "production" && driver !== "pinata") throw new ConfigurationError("Production protected media requires MEDIA_STORAGE_DRIVER=pinata.");
  const grantTtlSeconds = boundedPositiveInteger(env.MEDIA_GRANT_TTL_SECONDS, 300, "MEDIA_GRANT_TTL_SECONDS", { min: 30, max: 900 });
  const signedUrlTtlSeconds = boundedPositiveInteger(env.MEDIA_SIGNED_URL_TTL_SECONDS, 60, "MEDIA_SIGNED_URL_TTL_SECONDS", { min: 15, max: 300 });
  if (signedUrlTtlSeconds > grantTtlSeconds) throw new ConfigurationError("MEDIA_SIGNED_URL_TTL_SECONDS may not exceed MEDIA_GRANT_TTL_SECONDS.");
  const maxBytes = boundedPositiveInteger(env.MEDIA_MAX_BYTES, 104857600, "MEDIA_MAX_BYTES", { min: 1, max: 1073741824 });
  const auditHashSecret = secret(env.MEDIA_AUDIT_HASH_SECRET, "MEDIA_AUDIT_HASH_SECRET", { required: appEnvironment === "production" });
  if (driver === "filesystem") return Object.freeze({ driver, privateRoot: resolve(String(env.MEDIA_PRIVATE_ROOT || resolve(process.cwd(), "server/private-media"))), grantTtlSeconds, signedUrlTtlSeconds, maxBytes, auditHashSecret });
  if (driver === "pinata") {
    const jwt = secret(env.PINATA_JWT, "PINATA_JWT", { required: true });
    const gateway = normalizedUrl(env.PINATA_GATEWAY_URL, "PINATA_GATEWAY_URL");
    if (appEnvironment === "production" && gateway.protocol !== "https:") throw new ConfigurationError("Production PINATA_GATEWAY_URL must use HTTPS.");
    const objectUrlHosts = hostAllowlist(env.MEDIA_OBJECT_URL_HOSTS || gateway.host, "MEDIA_OBJECT_URL_HOSTS");
    if (!objectUrlHosts.includes(gateway.host.toLowerCase())) throw new ConfigurationError("MEDIA_OBJECT_URL_HOSTS must include the PINATA_GATEWAY_URL host.");
    return Object.freeze({ driver, grantTtlSeconds, signedUrlTtlSeconds, maxBytes, auditHashSecret, pinata: Object.freeze({ jwt, gateway: gateway.toString().replace(/\/$/, ""), endpoint: "https://api.pinata.cloud/v3/files/private/download_link" }), objectUrlHosts });
  }
  const accountId = String(env.R2_ACCOUNT_ID || "").trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new ConfigurationError("R2_ACCOUNT_ID must be a 32-character Cloudflare account ID.");
  const bucket = String(env.R2_BUCKET || "").trim();
  if (!bucket || /[\\/\s]/.test(bucket)) throw new ConfigurationError("R2_BUCKET must be a non-empty bucket name without spaces or slashes.");
  const accessKeyId = String(env.R2_ACCESS_KEY_ID || "").trim();
  if (!accessKeyId) throw new ConfigurationError("R2_ACCESS_KEY_ID is required.");
  const secretAccessKey = secret(env.R2_SECRET_ACCESS_KEY, "R2_SECRET_ACCESS_KEY", { required: true });
  const endpoint = normalizedUrl(env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`, "R2_ENDPOINT");
  if (appEnvironment === "production" && endpoint.protocol !== "https:") throw new ConfigurationError("Production R2_ENDPOINT must use HTTPS.");
  return Object.freeze({ driver, grantTtlSeconds, signedUrlTtlSeconds, maxBytes, auditHashSecret, r2: Object.freeze({ accountId, bucket, accessKeyId, secretAccessKey, endpoint: endpoint.toString() }), objectUrlHosts: hostAllowlist(env.MEDIA_OBJECT_URL_HOSTS, "MEDIA_OBJECT_URL_HOSTS"), protectedPrefixes: protectedPrefixes(env.MEDIA_OBJECT_PREFIXES, "MEDIA_OBJECT_PREFIXES") });
}

export function loadMetadataConfig(env = process.env) {
  const appEnvironment = String(env.NODE_ENV || "development").trim().toLowerCase();
  const driver = String(env.METADATA_STORAGE_DRIVER || "").trim().toLowerCase();
  if (!driver) return Object.freeze({ driver: null, appEnvironment });
  if (driver !== "pinata") throw new ConfigurationError("METADATA_STORAGE_DRIVER must be pinata.");
  const jwt = secret(env.PINATA_JWT, "PINATA_JWT", { required: true });
  const endpoint = normalizedUrl(env.PINATA_PIN_JSON_ENDPOINT || "https://api.pinata.cloud/pinning/pinJSONToIPFS", "PINATA_PIN_JSON_ENDPOINT");
  if (appEnvironment === "production" && endpoint.protocol !== "https:") throw new ConfigurationError("Production metadata storage requires an HTTPS Pinata endpoint.");
  return Object.freeze({ driver, appEnvironment, jwt, endpoint: endpoint.toString(), gateway: String(env.PINATA_GATEWAY_URL || "https://gateway.pinata.cloud/ipfs/").replace(/\/$/, "") + "/" });
}
