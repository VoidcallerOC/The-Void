import process from "node:process";
import { performance } from "node:perf_hooks";
import { Contract, Interface, JsonRpcProvider, Wallet, getAddress, hexlify, id, isAddress, randomBytes } from "ethers";
import { ApiError } from "./api-errors.js";
import { productionChainId } from "./config.js";
import { GENESIS_TOKEN_ID_SET, TRANSFER_BATCH_TOPIC, TRANSFER_SINGLE_TOPIC, decodeGenesisTransfers, replayUsedUnits, unitToUse, unusedUnits } from "./genesis-claim-ledger.js";

export const GENESIS_CONTRACT = "0xD1B4367dd9f235f9ee61878019d66E31511E98eE";
export const GENESIS_CHAIN_ID = 43114;
export const GENESIS_TOKEN_IDS = Object.freeze([0n, 1n, 2n, 3n]);
export const LEGACY_FUJI_SINGLETON = "0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6";
// Production schedule. C-Chain (43114) must use exactly the 24-hour claim window and the production
// price, and a public window within the production policy below; only Fuji may configure shorter test
// windows (never below one minute), as the claim contract also enforces.
// The free claim and the paid public sale run CONCURRENTLY: both open at claimStart, free claims stop
// at claimEnd = claimStart + claimWindow while paid minting continues until publicSaleEnd =
// claimStart + publicWindow - 1 (inclusive), when both close. claimWindow must be shorter than publicWindow.
export const CLAIM_WINDOW_SECONDS = 86_400n;
// The default public window when none is configured (the shortest production window).
export const PUBLIC_WINDOW_SECONDS = 7n * 86_400n;
// Production public-window policy, mirrored from GenesisHolderClaim: whole hours, 7 to 14 days. A sale
// opening on the hour then ends at :59:59, and a window one second short or long is refused.
export const MAINNET_MIN_PUBLIC_WINDOW_SECONDS = 7n * 86_400n;
export const MAINNET_MAX_PUBLIC_WINDOW_SECONDS = 14n * 86_400n;
export const MAINNET_PUBLIC_WINDOW_STEP_SECONDS = 3_600n;
export const MINIMUM_TEST_WINDOW_SECONDS = 60n;
export const MAINNET_PUBLIC_PRICE_WEI = 250_000_000_000_000_000n; // 0.25 AVAX

/**
 * Validates the schedule and price for the destination chain. Mainnet always gets the production
 * 24-hour claim at 0.25 AVAX and a public window of whole hours between 7 and 14 days; anything else
 * fails closed. Fuji windows default to production. On every chain the claim window must be shorter
 * than the public window, as the contract requires.
 */
export function claimSchedule({ destinationChainId, claimWindow = CLAIM_WINDOW_SECONDS, publicWindow = PUBLIC_WINDOW_SECONDS, publicPriceWei }) {
  if (destinationChainId === GENESIS_CHAIN_ID) {
    if (claimWindow !== CLAIM_WINDOW_SECONDS) throw new GenesisClaimConfigurationError("Mainnet requires a 24-hour Genesis claim window.");
    if (publicWindow < MAINNET_MIN_PUBLIC_WINDOW_SECONDS || publicWindow > MAINNET_MAX_PUBLIC_WINDOW_SECONDS || publicWindow % MAINNET_PUBLIC_WINDOW_STEP_SECONDS !== 0n) {
      throw new GenesisClaimConfigurationError(`Mainnet requires a public window of whole hours between 7 and 14 days (${MAINNET_MIN_PUBLIC_WINDOW_SECONDS}-${MAINNET_MAX_PUBLIC_WINDOW_SECONDS} seconds, a multiple of ${MAINNET_PUBLIC_WINDOW_STEP_SECONDS}); got ${publicWindow}.`);
    }
    if (publicPriceWei !== MAINNET_PUBLIC_PRICE_WEI) throw new GenesisClaimConfigurationError("Mainnet requires a public price of exactly 0.25 AVAX (250000000000000000 wei).");
  } else if (claimWindow < MINIMUM_TEST_WINDOW_SECONDS || publicWindow < MINIMUM_TEST_WINDOW_SECONDS) {
    throw new GenesisClaimConfigurationError("Claim and public windows must each be at least 60 seconds.");
  }
  // Claims run concurrently with the sale and must close strictly before the public sale ends.
  if (claimWindow >= publicWindow) throw new GenesisClaimConfigurationError("The Genesis claim window must be shorter than the public window: claims must close before the public sale ends.");
  return Object.freeze({ claimWindow, publicWindow });
}

/**
 * Eligibility is live ownership minus used units: when a voucher is requested, the wallet must hold, at
 * the current C-Chain block, at least one Genesis unit (IDs 0-3) that no earlier claim used (see
 * genesis-claim-ledger.js). The claim contract's ELIGIBILITY_RULE constant is the hash of this text, and
 * every voucher names it. Genesis tokens are only read, never moved or locked.
 */
export const ELIGIBILITY_RULE_TEXT = "the-void:genesis-eligibility:v3:live-balanceOf(wallet,0..3)-minus-units-used-by-earlier-claims>0;used-units-follow-transfers";
export const ELIGIBILITY_RULE = id(ELIGIBILITY_RULE_TEXT);

const GENESIS_INTERFACE = new Interface(["function balanceOf(address account,uint256 id) view returns (uint256)"]);
const CLAIM_ABI = [
  "function hasClaimed(address) view returns (bool)",
  "function claimedSupply() view returns (uint256)",
  "function allocation() view returns (uint256)",
  "function publicAllocation() view returns (uint256)",
  "function releaseContract() view returns (address)",
  "function primarySale() view returns (address)",
  "function tokenId() view returns (uint256)",
  "function signer() view returns (address)",
  "function destinationChainId() view returns (uint256)",
  "function claimStart() view returns (uint256)",
  "function claimEnd() view returns (uint256)",
  "function claimWindow() view returns (uint256)",
  "function publicWindow() view returns (uint256)",
  "function publicSaleStart() view returns (uint256)",
  "function publicSaleEnd() view returns (uint256)",
  "function publicPriceWei() view returns (uint256)",
  "function GENESIS_CONTRACT() view returns (address)",
  "function GENESIS_CHAIN_ID() view returns (uint256)",
  "function ELIGIBILITY_RULE() view returns (bytes32)",
  "function earlyAccessWallet() view returns (address)",
  "function earlyAccessStart() view returns (uint64)",
  "function earlyAccessEnd() view returns (uint64)",
  "function earlyAccessEnabled() view returns (bool)",
  "function earlyAccessClaimed() view returns (bool)",
];
const RELEASE_ABI = [
  "function maxSupplyOf(uint256 tokenId) view returns (uint256)",
  "function ISSUER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function edition(uint256 tokenId) view returns ((bytes32 releaseId,bytes32 editionId,address artist,uint256 maxSupply,uint256 mintedSupply,string metadataUri,bool exists))",
];
const SALE_ABI = ["function sales(uint256 tokenId) view returns (uint256 priceWei,uint256 maxSupply,uint256 sold,uint256 perWalletLimit,uint64 startTime,uint64 endTime,bool paused,bool configured)"];
const VOUCHER_TYPES = Object.freeze({
  ClaimVoucher: [
    { name: "claimant", type: "address" },
    { name: "genesisContract", type: "address" },
    { name: "genesisChainId", type: "uint256" },
    { name: "eligibilityRule", type: "bytes32" },
    { name: "destinationChainId", type: "uint256" },
    { name: "releaseContract", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "quantity", type: "uint256" },
    { name: "allocation", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
});

const EARLY_ACCESS_VOUCHER_TYPES = Object.freeze({
  EarlyAccessVoucher: [
    { name: "claimant", type: "address" },
    { name: "destinationChainId", type: "uint256" },
    { name: "releaseContract", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "quantity", type: "uint256" },
    { name: "windowStart", type: "uint256" },
    { name: "windowEnd", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
});

export class GenesisClaimConfigurationError extends Error {
  constructor(message) { super(message); this.name = "GenesisClaimConfigurationError"; }
}

const PLACEHOLDER_SIGNER = "0x000000000000000000000000000000000000dEaD";

function configuredAddress(value, name) {
  const raw = String(value || "").trim();
  if (!isAddress(raw) || getAddress(raw) === "0x0000000000000000000000000000000000000000") {
    throw new GenesisClaimConfigurationError(`${name} must be a non-zero EVM address.`);
  }
  return getAddress(raw);
}

function positiveBigInt(value, name) {
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) throw new Error();
    return parsed;
  } catch {
    throw new GenesisClaimConfigurationError(`${name} must be a positive integer.`);
  }
}

function nonNegativeBigInt(value, name) {
  try {
    const text = String(value ?? "").trim();
    if (!/^(0|[1-9]\d*)$/.test(text)) throw new Error();
    return BigInt(text);
  } catch {
    throw new GenesisClaimConfigurationError(`${name} must be a non-negative integer.`);
  }
}

function httpUrl(value, name) {
  try {
    const url = new URL(String(value || "").trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) throw new Error();
    return url.toString();
  } catch {
    throw new GenesisClaimConfigurationError(`${name} must be an absolute HTTP(S) URL without credentials or a fragment.`);
  }
}

/**
 * The signer rules shared by claim activation and the startup check: a 32-byte hex secret, a valid
 * non-placeholder public address, and the address must be the one the secret derives. Messages never
 * contain the secret or the derived address.
 */
function validateGenesisSignerConfig(env) {
  const privateKey = String(env.GENESIS_CLAIM_SIGNER_PRIVATE_KEY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new GenesisClaimConfigurationError("GENESIS_CLAIM_SIGNER_PRIVATE_KEY must be a server-side 32-byte hex secret.");
  // The intended voucher signer is a public address configured beside the secret. Fail closed unless it
  // is valid, is not the dead placeholder, and is exactly the address the secret derives. The claim
  // contract's own signer() is then compared with it at service start (binding check).
  const signerAddress = configuredAddress(env.GENESIS_CLAIM_SIGNER_ADDRESS, "GENESIS_CLAIM_SIGNER_ADDRESS");
  if (signerAddress.toLowerCase() === PLACEHOLDER_SIGNER.toLowerCase()) throw new GenesisClaimConfigurationError("GENESIS_CLAIM_SIGNER_ADDRESS may not be the dead placeholder address; no key exists for it.");
  if (new Wallet(privateKey).address.toLowerCase() !== signerAddress.toLowerCase()) throw new GenesisClaimConfigurationError("GENESIS_CLAIM_SIGNER_PRIVATE_KEY does not derive GENESIS_CLAIM_SIGNER_ADDRESS.");
  return { privateKey, signerAddress };
}

/**
 * Startup diagnostic that works while GENESIS_CLAIM_ENABLED is unset. It never throws, never enables
 * claims, and returns only a status, the derived PUBLIC address (when the secret is well formed) and a
 * fixed reason string. ABSENT: neither variable is set. INCOMPLETE: only one is set.
 */
export function checkGenesisSignerConfig(env = process.env) {
  const hasKey = String(env.GENESIS_CLAIM_SIGNER_PRIVATE_KEY || "").trim() !== "";
  const hasAddress = String(env.GENESIS_CLAIM_SIGNER_ADDRESS || "").trim() !== "";
  if (!hasKey && !hasAddress) return { status: "ABSENT" };
  if (hasKey !== hasAddress) return { status: "INCOMPLETE", reason: hasKey ? "GENESIS_CLAIM_SIGNER_ADDRESS is not set." : "GENESIS_CLAIM_SIGNER_PRIVATE_KEY is not set." };
  let derivedAddress = null;
  try {
    const key = String(env.GENESIS_CLAIM_SIGNER_PRIVATE_KEY).trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(key)) derivedAddress = new Wallet(key).address;
    validateGenesisSignerConfig(env);
    return { status: "MATCH", derivedAddress };
  } catch (error) {
    const reason = error instanceof GenesisClaimConfigurationError ? error.message : "Signer configuration could not be evaluated.";
    return { status: "MISMATCH", ...(derivedAddress ? { derivedAddress } : {}), reason };
  }
}

export function loadGenesisClaimConfig(env = process.env) {
  if (String(env.GENESIS_CLAIM_ENABLED || "").toLowerCase() !== "true") return null;
  const destinationChainId = productionChainId(env);
  const releaseContract = configuredAddress(env.GENESIS_CLAIM_RELEASE_CONTRACT, "GENESIS_CLAIM_RELEASE_CONTRACT");
  const primarySale = configuredAddress(env.GENESIS_CLAIM_PRIMARY_SALE, "GENESIS_CLAIM_PRIMARY_SALE");
  const claimContract = configuredAddress(env.GENESIS_CLAIM_CONTRACT, "GENESIS_CLAIM_CONTRACT");
  if (releaseContract.toLowerCase() === LEGACY_FUJI_SINGLETON.toLowerCase()) {
    throw new GenesisClaimConfigurationError("The legacy Fuji V2 singleton may not be the claim release target.");
  }
  if (releaseContract.toLowerCase() === claimContract.toLowerCase() || primarySale.toLowerCase() === releaseContract.toLowerCase()) {
    throw new GenesisClaimConfigurationError("The release, primary sale, and claim contract must be distinct addresses.");
  }
  const tokenIdValue = String(env.GENESIS_CLAIM_TOKEN_ID ?? "").trim();
  if (!/^(0|[1-9]\d*)$/.test(tokenIdValue)) throw new GenesisClaimConfigurationError("GENESIS_CLAIM_TOKEN_ID must be a non-negative integer.");
  const tokenId = BigInt(tokenIdValue);
  // 0 means uncapped: an open edition has no reserved claim allocation and no public sale cap.
  const allocation = nonNegativeBigInt(env.GENESIS_CLAIM_ALLOCATION, "GENESIS_CLAIM_ALLOCATION");
  const publicAllocation = nonNegativeBigInt(env.GENESIS_PUBLIC_MINT_ALLOCATION, "GENESIS_PUBLIC_MINT_ALLOCATION");
  const claimStart = positiveBigInt(env.GENESIS_CLAIM_START, "GENESIS_CLAIM_START");
  const publicPriceWei = positiveBigInt(env.GENESIS_PUBLIC_PRICE_WEI, "GENESIS_PUBLIC_PRICE_WEI");
  const { claimWindow, publicWindow } = claimSchedule({
    destinationChainId,
    claimWindow: env.GENESIS_CLAIM_WINDOW_SECONDS === undefined || env.GENESIS_CLAIM_WINDOW_SECONDS === "" ? CLAIM_WINDOW_SECONDS : positiveBigInt(env.GENESIS_CLAIM_WINDOW_SECONDS, "GENESIS_CLAIM_WINDOW_SECONDS"),
    publicWindow: env.GENESIS_PUBLIC_WINDOW_SECONDS === undefined || env.GENESIS_PUBLIC_WINDOW_SECONDS === "" ? PUBLIC_WINDOW_SECONDS : positiveBigInt(env.GENESIS_PUBLIC_WINDOW_SECONDS, "GENESIS_PUBLIC_WINDOW_SECONDS"),
    publicPriceWei,
  });
  const { privateKey, signerAddress } = validateGenesisSignerConfig(env);
  const earlyAccess = loadEarlyAccessConfig(env, { claimStart, signerAddress, addresses: [releaseContract, primarySale, claimContract, GENESIS_CONTRACT] });
  return Object.freeze({
    destinationChainId,
    genesisRpcUrl: httpUrl(env.GENESIS_RPC_URL, "GENESIS_RPC_URL"),
    destinationRpcUrl: httpUrl(env.GENESIS_DESTINATION_RPC_URL, "GENESIS_DESTINATION_RPC_URL"),
    releaseContract,
    primarySale,
    claimContract,
    tokenId,
    allocation,
    publicAllocation,
    claimStart,
    claimWindow,
    publicWindow,
    claimEnd: claimStart + claimWindow,
    // The paid sale opens with the claims and its inclusive end gives a window of exactly publicWindow.
    publicSaleStart: claimStart,
    publicSaleEnd: claimStart + publicWindow - 1n,
    publicPriceWei,
    eligibilityRule: ELIGIBILITY_RULE,
    signerAddress,
    privateKey,
    earlyAccess,
    scan: scanOptions(env),
  });
}

/**
 * Optional one-wallet early access, off unless GENESIS_EARLY_ACCESS_ENABLED=true. When on, the wallet and
 * window must be explicitly configured and valid, or the whole claim configuration fails closed: one
 * non-zero wallet that is not the signer or a contract in the binding, and a window
 * GENESIS_EARLY_ACCESS_START <= t < GENESIS_EARLY_ACCESS_END that ends no later than claimStart.
 */
function loadEarlyAccessConfig(env, { claimStart, signerAddress, addresses }) {
  if (String(env.GENESIS_EARLY_ACCESS_ENABLED || "").toLowerCase() !== "true") return null;
  const wallet = configuredAddress(env.GENESIS_EARLY_ACCESS_WALLET, "GENESIS_EARLY_ACCESS_WALLET");
  if ([signerAddress, ...addresses].some((address) => address.toLowerCase() === wallet.toLowerCase())) {
    throw new GenesisClaimConfigurationError("GENESIS_EARLY_ACCESS_WALLET may not be the voucher signer or a claim, release, sale, or Genesis contract.");
  }
  const start = positiveBigInt(env.GENESIS_EARLY_ACCESS_START, "GENESIS_EARLY_ACCESS_START");
  const end = positiveBigInt(env.GENESIS_EARLY_ACCESS_END, "GENESIS_EARLY_ACCESS_END");
  if (start >= end || end > claimStart) throw new GenesisClaimConfigurationError("The early-access window must start before it ends and end no later than GENESIS_CLAIM_START.");
  return Object.freeze({ wallet, start, end });
}

function toPublicConfig(config) {
  if (!config) return null;
  return Object.freeze({
    enabled: true,
    genesisContract: GENESIS_CONTRACT,
    genesisChainId: GENESIS_CHAIN_ID,
    tokenIds: GENESIS_TOKEN_IDS.map(String),
    eligibilityRule: config.eligibilityRule,
    eligibility: "live",
    destinationChainId: config.destinationChainId,
    releaseContract: config.releaseContract,
    primarySale: config.primarySale,
    claimContract: config.claimContract,
    tokenId: config.tokenId.toString(),
    allocation: config.allocation.toString(),
    publicAllocation: config.publicAllocation.toString(),
    claimStart: config.claimStart.toString(),
    claimEnd: config.claimEnd.toString(),
    claimWindow: config.claimWindow.toString(),
    publicWindow: config.publicWindow.toString(),
    publicSaleStart: config.publicSaleStart.toString(),
    publicSaleEnd: config.publicSaleEnd.toString(),
    publicPriceWei: config.publicPriceWei.toString(),
    // The window only; the approved wallet is never published by the API.
    earlyAccess: config.earlyAccess ? Object.freeze({ start: config.earlyAccess.start.toString(), end: config.earlyAccess.end.toString() }) : null,
  });
}

export const VOUCHER_LIFETIME_SECONDS = 300;
// Seconds past a voucher's deadline before an unredeemed issuance is released (destination-chain time).
export const RESERVATION_EXPIRY_GRACE_SECONDS = 120n;
// Maximum inclusive block span per eth_getLogs request for Genesis transfers. The public Avalanche
// C-Chain RPC rejects eth_getLogs ranges above 100 blocks, so each request covers [start, start + 99].
export const TRANSFER_LOG_CHUNK_BLOCKS = 100;

// Provider error codes that may be logged: ethers' fixed error enum. Anything else is dropped.
const SAFE_PROVIDER_CODE = /^[A-Z][A-Z_]{1,40}$/;

/**
 * A provider error reduced to a code that cannot carry a URL, address, credential or message: the
 * numeric JSON-RPC error code, the HTTP status, or ethers' error enum, in that order; otherwise null.
 */
export function sanitizeProviderErrorCode(error) {
  const rpc = error?.error?.code ?? error?.info?.error?.code;
  if (Number.isInteger(rpc)) return { rpcCode: rpc };
  const status = error?.status ?? error?.info?.responseStatus ?? error?.response?.statusCode;
  const httpStatus = Number.isInteger(status) ? status : Number.parseInt(String(status ?? "").match(/^\s*(\d{3})\b/)?.[1], 10);
  if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) return { httpStatus };
  if (Number.isInteger(error?.code)) return { rpcCode: error.code };
  if (typeof error?.code === "string" && SAFE_PROVIDER_CODE.test(error.code)) return { providerCode: error.code };
  return null;
}

// Scan tuning. Chunk size may be lowered but never raised above the public RPC's 100-block cap.
export const SCAN_DEFAULTS = Object.freeze({ chunkBlocks: TRANSFER_LOG_CHUNK_BLOCKS, paceMs: 100, maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 4_000, budgetMs: 45_000, confirmations: 32 });
const SCAN_LIMITS = Object.freeze({
  chunkBlocks: ["GENESIS_LOG_CHUNK_BLOCKS", 1, TRANSFER_LOG_CHUNK_BLOCKS],
  paceMs: ["GENESIS_RPC_PACE_MS", 0, 5_000],
  maxAttempts: ["GENESIS_RPC_MAX_ATTEMPTS", 1, 10],
  baseDelayMs: ["GENESIS_RPC_RETRY_BASE_MS", 1, 10_000],
  maxDelayMs: ["GENESIS_RPC_RETRY_MAX_DELAY_MS", 1, 30_000],
  budgetMs: ["GENESIS_SCAN_BUDGET_MS", 1_000, 60_000],
  confirmations: ["GENESIS_SCAN_CONFIRMATIONS", 1, 1_024],
});
export function scanOptions(env = {}) {
  const options = {};
  for (const [key, [name, min, max]] of Object.entries(SCAN_LIMITS)) {
    const raw = String(env[name] ?? "").trim();
    if (!raw) { options[key] = SCAN_DEFAULTS[key]; continue; }
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new GenesisClaimConfigurationError(`${name} must be an integer from ${min} to ${max}.`);
    options[key] = Number(raw);
  }
  return Object.freeze(options);
}

/** The scan ran out of its time budget; the request fails closed rather than hanging. */
export class GenesisScanBudgetError extends Error {
  constructor() { super("Genesis transfer scan exceeded its time budget."); this.name = "GenesisScanBudgetError"; this.code = "TIMEOUT"; }
}
const RETRYABLE_HTTP = new Set([429, 502, 503, 504, 599]);
const RETRYABLE_RPC = new Set([429, -32005]);
const RETRYABLE_CODES = new Set(["TIMEOUT", "NETWORK_ERROR", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "ABORT_ERR"]);
/** Throttling, gateway, timeout and transient network failures are retried; anything else (bad params, range too large) is not. */
export function isRetryableProviderError(error) {
  if (!error || error instanceof ApiError || error instanceof GenesisScanBudgetError) return false;
  const code = sanitizeProviderErrorCode(error);
  if (code?.httpStatus !== undefined) return RETRYABLE_HTTP.has(code.httpStatus);
  if (code?.rpcCode !== undefined) return RETRYABLE_RPC.has(code.rpcCode);
  const name = error.code ?? error.cause?.code;
  if (typeof name === "string" && RETRYABLE_CODES.has(name)) return true;
  if (error.name === "AbortError" || error.name === "TimeoutError" || error.cause?.name === "AbortError") return true;
  return /socket hang up|ECONNRESET|ETIMEDOUT|network timeout|request timeout/i.test(String(error.message ?? ""));
}
/** Retry-After in milliseconds (seconds or an HTTP date), or null. */
export function retryAfterMs(error, nowMs = Date.now()) {
  const headers = error?.info?.responseHeaders ?? error?.response?.headers ?? {};
  const raw = typeof headers.get === "function" ? headers.get("retry-after") : (headers["retry-after"] ?? headers["Retry-After"] ?? error?.retryAfter);
  if (raw === undefined || raw === null || raw === "") return null;
  if (/^\s*\d+(\.\d+)?\s*$/.test(String(raw))) return Math.round(Number(raw) * 1000);
  const at = Date.parse(String(raw));
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}
/**
 * Runs `operation` with bounded exponential backoff and full jitter. Stops on a non-retryable error,
 * after maxAttempts, or when the next wait would pass `deadline`; the last error is rethrown (fail closed).
 */
export async function withProviderRetry(operation, { maxAttempts, baseDelayMs, maxDelayMs, deadline = Infinity, now, sleep, random }) {
  for (let attempt = 0; ; attempt += 1) {
    if (now() > deadline) throw new GenesisScanBudgetError();
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableProviderError(error) || attempt + 1 >= maxAttempts) throw error;
      let delay = Math.floor(random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
      const hinted = retryAfterMs(error);
      if (hinted !== null) delay = Math.max(delay, Math.min(hinted, maxDelayMs));
      if (now() + delay > deadline) throw error;
      await sleep(delay);
    }
  }
}

const STAGE = Symbol("genesisUpstreamStage");
/** Labels the first upstream stage an error passed through; later labels never overwrite it. */
async function atStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error && typeof error === "object" && !(error instanceof ApiError) && !error[STAGE]) {
      try { Object.defineProperty(error, STAGE, { value: stage }); } catch { /* frozen error: stage stays unknown */ }
    }
    throw error;
  }
}

/**
 * Settles stored PENDING reservations from the claim contract, the source of truth (hasClaimed).
 * The service settles lazily, only inside issueVoucher, which stops running once the claim window
 * closes, so a redeemed voucher's row would stay PENDING for good. This performs that settlement on
 * demand: claimed -> REDEEMED; unclaimed and past deadline plus grace -> EXPIRED; otherwise untouched.
 * Idempotent: REDEEMED and EXPIRED rows are never read or rewritten, and the used-unit ledger is
 * unchanged because activeReservations already treats these transitions as equivalent.
 * With apply=false (default) it reports the transitions and writes nothing.
 */
export async function reconcileGenesisReservations({ store, claimContract, readAlreadyClaimed, destinationNow, apply = false } = {}) {
  if (!store?.withLock || typeof readAlreadyClaimed !== "function" || typeof destinationNow !== "function") throw new TypeError("Reservation reconciliation requires the store, a hasClaimed reader and a destination clock.");
  return store.withLock(claimContract, async (tx) => {
    const pending = (await tx.list()).filter((record) => record.status === "PENDING");
    const now = pending.length ? BigInt(await destinationNow()) : 0n;
    const transitions = [];
    for (const record of pending) {
      const claimed = await readAlreadyClaimed(record.wallet);
      let status = null;
      if (claimed) status = "REDEEMED";
      else if (BigInt(record.deadline) + RESERVATION_EXPIRY_GRACE_SECONDS < now) status = "EXPIRED";
      if (!status) continue;
      if (apply) await tx.setStatus(record.wallet, status);
      transitions.push({ wallet: record.wallet, from: "PENDING", to: status, applied: apply });
    }
    return Object.freeze({ pending: pending.length, transitions });
  });
}

export function createGenesisClaimService({
  config = loadGenesisClaimConfig(),
  genesisProvider = null,
  destinationProvider = null,
  signer = null,
  reservationStore = null,
  balanceReader = null,
  transferLogReader = null,
  bindingReader = null,
  claimStateReader = null,
  earlyAccessStateReader = null,
  destinationClock = null,
  clock = () => Math.floor(Date.now() / 1000),
  logger = console,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  random = Math.random,
  monotonicNow = () => performance.now(),
  // 256 random bits. ethers' randomBytes returns a Uint8Array, so it must be hex-encoded explicitly.
  nonce = () => BigInt(hexlify(randomBytes(32))),
} = {}) {
  if (!config) return null;
  // The used-unit ledger is what stops one Genesis unit from qualifying wallet after wallet; without
  // shared, durable storage for it the claim must not run.
  if (!reservationStore) throw new GenesisClaimConfigurationError("The Genesis claim requires the reservation store (migration 039).");
  const sourceProvider = genesisProvider || new JsonRpcProvider(config.genesisRpcUrl);
  const targetProvider = destinationProvider || new JsonRpcProvider(config.destinationRpcUrl);
  const claimSigner = signer || new Wallet(config.privateKey);
  const claim = new Contract(config.claimContract, CLAIM_ABI, targetProvider);
  const release = new Contract(config.releaseContract, RELEASE_ABI, targetProvider);
  const sale = new Contract(config.primarySale, SALE_ABI, targetProvider);

  async function verifyContractBindings() {
    const [network, claimRelease, claimSale, claimToken, claimAllocation, claimPublicAllocation, claimChain, claimStartAt, claimEndAt,
      claimWindowAt, publicWindowAt, claimPublicStart, claimPublicEnd, claimPrice, claimGenesis, claimGenesisChain, claimRule, claimSignerAddress, claimedSupply, maxSupply, editionData, saleData] = await Promise.all([
      targetProvider.getNetwork(), claim.releaseContract(), claim.primarySale(), claim.tokenId(), claim.allocation(),
      claim.publicAllocation(), claim.destinationChainId(), claim.claimStart(), claim.claimEnd(), claim.claimWindow(), claim.publicWindow(),
      claim.publicSaleStart(), claim.publicSaleEnd(), claim.publicPriceWei(),
      claim.GENESIS_CONTRACT(), claim.GENESIS_CHAIN_ID(), claim.ELIGIBILITY_RULE(), claim.signer(), claim.claimedSupply(),
      release.maxSupplyOf(config.tokenId), release.edition(config.tokenId), sale.sales(config.tokenId),
    ]);
    // The claim mints through the release's issuer path; without the grant every claim would revert.
    const claimIsIssuer = await release.hasRole(await release.ISSUER_ROLE(), config.claimContract);
    const total = config.allocation + config.publicAllocation;
    // An open edition (maxSupply 0) has no cap to compare against.
    const editionCapTooSmall = BigInt(maxSupply) !== 0n && (config.allocation === 0n || BigInt(maxSupply) < total);
    if (Number(network.chainId) !== config.destinationChainId
      || getAddress(claimRelease) !== config.releaseContract
      || getAddress(claimSale) !== config.primarySale
      || BigInt(claimToken) !== config.tokenId
      || BigInt(claimAllocation) !== config.allocation
      || BigInt(claimPublicAllocation) !== config.publicAllocation
      || BigInt(claimChain) !== BigInt(config.destinationChainId)
      || BigInt(claimStartAt) !== config.claimStart
      || BigInt(claimEndAt) !== config.claimEnd
      || BigInt(claimWindowAt) !== config.claimWindow
      || BigInt(publicWindowAt) !== config.publicWindow
      || BigInt(claimPublicStart) !== config.publicSaleStart
      || BigInt(claimPublicEnd) !== config.publicSaleEnd
      || BigInt(claimPrice) !== config.publicPriceWei
      || getAddress(claimGenesis) !== GENESIS_CONTRACT
      || BigInt(claimGenesisChain) !== BigInt(GENESIS_CHAIN_ID)
      || String(claimRule).toLowerCase() !== config.eligibilityRule.toLowerCase()
      || getAddress(claimSignerAddress) !== getAddress(claimSigner.address)
      || editionCapTooSmall
      || !claimIsIssuer
      || BigInt(editionData.mintedSupply ?? editionData[0]?.mintedSupply ?? editionData[0]?.[4] ?? editionData[4]) !== BigInt(saleData.sold ?? saleData[2]) + BigInt(claimedSupply)
      || BigInt(saleData.priceWei ?? saleData[0]) !== config.publicPriceWei
      || BigInt(saleData.maxSupply ?? saleData[1]) !== config.publicAllocation
      // The paid sale opens together with the claims, not when they close.
      || BigInt(saleData.startTime ?? saleData[4]) !== config.publicSaleStart
      || BigInt(saleData.endTime ?? saleData[5]) !== config.publicSaleEnd
      || !(saleData.configured ?? saleData[7])) {
      throw new ApiError(503, "CLAIM_BINDING_MISMATCH", "The configured claim contract, release, supply, or chain does not match the authorized target.");
    }
  }

  // Ownership is read from C-Chain only. A provider on any other chain fails closed.
  async function assertGenesisChain() {
    const network = await sourceProvider.getNetwork();
    if (Number(network.chainId) !== GENESIS_CHAIN_ID) throw new Error("Genesis RPC is not Avalanche C-Chain (43114).");
  }

  async function readHead() {
    return atStage("readHead", async () => {
      await assertGenesisChain();
      const head = Number(await sourceProvider.getBlockNumber());
      if (!Number.isSafeInteger(head) || head <= 0) throw new Error("Invalid C-Chain block number.");
      return head;
    });
  }

  /** Balances of Genesis IDs 0-3 at one C-Chain block, as decimal strings keyed by ID. */
  async function readBalances(wallet, block) {
    return atStage("balances", () => readBalancesUnlabelled(wallet, block));
  }
  async function readBalancesUnlabelled(wallet, block) {
    const raw = balanceReader
      ? await balanceReader(wallet, block)
      : Object.fromEntries(await Promise.all(GENESIS_TOKEN_IDS.map(async (tokenId) => {
        const data = GENESIS_INTERFACE.encodeFunctionData("balanceOf", [wallet, tokenId]);
        return [tokenId.toString(), GENESIS_INTERFACE.decodeFunctionResult("balanceOf", await sourceProvider.call({ to: GENESIS_CONTRACT, data, blockTag: block }))[0]];
      })));
    return Object.freeze(Object.fromEntries(GENESIS_TOKEN_ID_SET.map((id) => {
      const value = BigInt(raw?.[id] ?? 0);
      if (value < 0n) throw new Error("Negative Genesis balance.");
      return [id, value.toString()];
    })));
  }

  // Genesis TransferSingle/TransferBatch history. A free public RPC caps eth_getLogs at 100 blocks and
  // throttles bursts, so the scan is paced, retried with bounded backoff, and reused: a completed scan is
  // kept in process up to `confirmations` blocks behind the head, keyed by its first and last block and
  // the last block's hash. A later request re-verifies that hash and scans only the blocks after it.
  // Scans are serialized (single flight): a concurrent request waits, then reuses the cache. Only a
  // complete, contiguous, successful scan is cached; any failure leaves the cache as it was and fails closed.
  const scan = config.scan || scanOptions({});
  let verifiedHistory = null; // { from, end, endHash, logs } with end <= head - confirmations
  let lastRpcAt = -Infinity;
  async function paced(operation, deadline) {
    const wait = lastRpcAt + scan.paceMs - monotonicNow();
    if (wait > 0) {
      if (monotonicNow() + wait > deadline) throw new GenesisScanBudgetError();
      await sleep(wait);
    }
    try { return await operation(); } finally { lastRpcAt = monotonicNow(); }
  }
  const rpc = (operation, deadline) => withProviderRetry(() => paced(operation, deadline), { ...scan, deadline, now: monotonicNow, sleep, random });
  async function blockHash(block, deadline) {
    return atStage("blockHash", async () => {
      const found = await rpc(() => sourceProvider.getBlock(block), deadline);
      if (!found || typeof found.hash !== "string" || Number(found.number) !== block) throw new Error("C-Chain block could not be read.");
      return found.hash.toLowerCase();
    });
  }
  async function fetchLogs(fromBlock, toBlock, deadline) {
    return atStage("getLogs", async () => {
      const logs = [];
      // Inclusive ranges [start, min(start + chunk - 1, toBlock)]; the next starts at end + 1: no gap, no overlap.
      for (let start = fromBlock; start <= toBlock;) {
        const end = Math.min(toBlock, start + scan.chunkBlocks - 1);
        logs.push(...await rpc(() => sourceProvider.getLogs({ address: GENESIS_CONTRACT, topics: [[TRANSFER_SINGLE_TOPIC, TRANSFER_BATCH_TOPIC]], fromBlock: start, toBlock: end }), deadline));
        start = end + 1;
      }
      return logs;
    });
  }
  async function scanTransfers(fromBlock, head) {
    const deadline = monotonicNow() + scan.budgetMs;
    let cached = verifiedHistory;
    if (cached && (cached.from > fromBlock || cached.end > head)) cached = null;
    // A reorg (or a provider on another fork) changes the hash: drop the cache and rescan everything.
    if (cached && await blockHash(cached.end, deadline) !== cached.endHash) cached = verifiedHistory = null;
    const scanFrom = cached ? cached.end + 1 : fromBlock;
    const fresh = await fetchLogs(scanFrom, head, deadline);
    const logs = cached ? [...cached.logs, ...fresh] : fresh;
    const safeEnd = head - scan.confirmations;
    if (safeEnd >= scanFrom) {
      const endHash = await blockHash(safeEnd, deadline);
      verifiedHistory = Object.freeze({ from: cached ? cached.from : fromBlock, end: safeEnd, endHash, logs: Object.freeze(logs.filter((log) => Number(log.blockNumber) <= safeEnd)) });
    }
    return logs;
  }
  // Single flight: a request whose range is covered by the scan in progress joins it and shares its
  // outcome, success or failure; nothing is kept once it settles, so the next request scans afresh.
  let inflight = null; // { from, promise }
  function sharedScan(fromBlock, head) {
    if (inflight && inflight.from <= fromBlock) return inflight.promise;
    const prior = inflight ? inflight.promise.catch(() => {}) : Promise.resolve();
    const entry = { from: fromBlock, promise: null };
    entry.promise = prior.then(() => scanTransfers(fromBlock, head)).then((logs) => ({ head, logs }))
      .finally(() => { if (inflight === entry) inflight = null; });
    inflight = entry;
    return entry.promise;
  }
  /** Genesis transfers in [fromBlock, through], where `through` is the head the (possibly shared) scan reached. */
  async function transfersFrom(fromBlock, head) {
    if (transferLogReader) return { through: head, transfers: decodeGenesisTransfers(await atStage("getLogs", () => transferLogReader(fromBlock, head))) };
    const result = await sharedScan(fromBlock, head);
    return { through: result.head, transfers: decodeGenesisTransfers(result.logs).filter((transfer) => transfer.block >= fromBlock && transfer.block <= result.head) };
  }

  async function readClaimState(wallet) {
    return atStage("claimState", () => readClaimStateUnlabelled(wallet));
  }
  async function readClaimStateUnlabelled(wallet) {
    return claimStateReader
      ? claimStateReader(wallet)
      : Promise.all([claim.hasClaimed(wallet), claim.claimedSupply()]).then(([alreadyClaimed, claimedSupply]) => ({ alreadyClaimed, claimedSupply }));
  }

  async function destinationNow() {
    return atStage("destinationClock", () => destinationNowUnlabelled());
  }
  async function destinationNowUnlabelled() {
    if (destinationClock) return BigInt(await destinationClock());
    const block = await targetProvider.getBlock("latest");
    return BigInt(block.timestamp);
  }

  /**
   * Issuances that still use Genesis units: REDEEMED ones, and PENDING ones whose voucher can still be
   * redeemed. A PENDING issuance past its deadline (plus grace) on the destination chain is settled
   * from hasClaimed: REDEEMED, or EXPIRED and released. `tx` persists settlements when present.
   */
  async function activeReservations(records, tx = null) {
    const pendingExpired = records.filter((record) => record.status === "PENDING");
    const now = pendingExpired.length ? await destinationNow() : 0n;
    const active = [];
    for (const record of records) {
      if (record.status === "EXPIRED") continue;
      if (record.status === "REDEEMED" || BigInt(record.deadline) + RESERVATION_EXPIRY_GRACE_SECONDS >= now) {
        active.push(record);
        continue;
      }
      const { alreadyClaimed } = await readClaimState(record.wallet);
      const status = alreadyClaimed ? "REDEEMED" : "EXPIRED";
      if (tx) await tx.setStatus(record.wallet, status);
      if (alreadyClaimed) active.push({ ...record, status });
    }
    return active;
  }

  /** The wallet's balances and unused units at the current C-Chain head, given the active issuances. */
  async function ledgerPosition(wallet, active) {
    const head = await readHead();
    const latestIssued = active.reduce((max, record) => Math.max(max, Number(record.block)), 0);
    if (latestIssued > head) throw new Error("C-Chain provider is behind the claim ledger.");
    const earliestIssued = active.reduce((min, record) => Math.min(min, Number(record.block)), Infinity);
    let through = head;
    let transfers = [];
    if (Number.isFinite(earliestIssued)) {
      ({ through, transfers } = await transfersFrom(earliestIssued + 1, head));
      // A joined scan that ended before this ledger's newest issuance cannot judge it: scan again.
      if (through < latestIssued) ({ through, transfers } = await transfersFrom(earliestIssued + 1, head));
      if (through < latestIssued) throw new Error("Genesis transfer history is behind the claim ledger.");
    }
    const used = replayUsedUnits({ reservations: active, transfers, throughBlock: through });
    const balances = await readBalances(wallet, through);
    return { head: through, balances, unused: unusedUnits(wallet, balances, used) };
  }

  /**
   * One structured diagnostic per upstream failure, at the catch that turns it into a 503. Only the
   * request ID, a fixed stage label and a sanitized provider code: never a wallet, URL, credential,
   * voucher, signature or raw provider message.
   */
  function logUpstreamError(error, requestId, fallbackStage) {
    logger?.warn?.("genesis.eligibility.upstream_error", {
      requestId: typeof requestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? requestId : null,
      stage: error?.[STAGE] || fallbackStage,
      providerError: sanitizeProviderErrorCode(error),
    });
  }

  const heldIds = (units) => GENESIS_TOKEN_ID_SET.filter((id) => BigInt(units[id]) > 0n);

  function assertWallet(wallet) {
    if (!isAddress(wallet) || getAddress(wallet) === "0x0000000000000000000000000000000000000000") {
      throw new ApiError(400, "INVALID_WALLET", "A non-zero claimant wallet address is required.");
    }
    return getAddress(wallet);
  }

  async function checkEligibility(walletInput, { requestId = null } = {}) {
    const wallet = assertWallet(walletInput);
    try {
      // Read-only: the lock covers only the ledger read. The transfer scan runs outside it, so concurrent
      // requests can share one in-flight scan (and its failure) instead of queueing full scans.
      const records = await reservationStore.withLock(config.claimContract, (tx) => tx.list());
      const active = await activeReservations(records);
      const own = active.find((record) => getAddress(record.wallet) === wallet);
      if (own) return Object.freeze({ eligible: own.status === "PENDING", eligibleTokenIds: heldIds(own.balances), holdingUsed: false, claimIssued: true });
      const { balances, unused } = await ledgerPosition(wallet, active);
      const eligibleTokenIds = heldIds(unused);
      return Object.freeze({ eligible: eligibleTokenIds.length > 0, eligibleTokenIds, holdingUsed: heldIds(balances).length > 0 && eligibleTokenIds.length === 0, claimIssued: false });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logUpstreamError(error, requestId, "reservationStore");
      throw new ApiError(503, "ELIGIBILITY_UNAVAILABLE", "Genesis ownership could not be verified on Avalanche C-Chain.");
    }
  }

  async function issueVoucher(walletInput, { requestId = null } = {}) {
    const wallet = assertWallet(walletInput);
    const now = BigInt(clock());
    if (now < config.claimStart) throw new ApiError(409, "CLAIM_NOT_OPEN", "The Genesis claim window has not opened yet.");
    if (now >= config.claimEnd) throw new ApiError(409, "CLAIM_WINDOW_CLOSED", "The Genesis claim window has closed.");
    try {
      if (bindingReader) await bindingReader();
      else await verifyContractBindings();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logUpstreamError(error, requestId, "bindings");
      throw new ApiError(503, "CLAIM_AUTHORIZATION_UNAVAILABLE", "Claim authorization could not be issued for the configured destination.");
    }
    // Warm the shared transfer history outside the lock, so concurrent issuances join one scan; the
    // decision below is still made, and recorded, under the lock (it then scans only newer blocks).
    try {
      const records = await reservationStore.withLock(config.claimContract, (tx) => tx.list());
      const active = await activeReservations(records);
      if (active.length) await ledgerPosition(wallet, active);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      logUpstreamError(error, requestId, "reservationStore");
      throw new ApiError(503, "ELIGIBILITY_UNAVAILABLE", "Genesis ownership could not be verified on Avalanche C-Chain.");
    }
    // One issuance at a time per claim contract: the holding a wallet is judged on cannot be judged for
    // another wallet until this issuance is recorded.
    return reservationStore.withLock(config.claimContract, async (tx) => {
      let active;
      let position;
      let claimState;
      try {
        const records = await tx.list();
        active = await activeReservations(records, tx);
        claimState = await readClaimState(wallet);
        const own = active.find((record) => getAddress(record.wallet) === wallet);
        if (claimState.alreadyClaimed || own?.status === "REDEEMED") throw new ApiError(409, "ALREADY_CLAIMED", "This wallet has already claimed its Genesis allocation.");
        // A wallet that already holds an unexpired voucher gets the same voucher back: same nonce, so it
        // can be redeemed at most once.
        if (own) return Object.freeze({ voucher: own.voucher, signature: own.signature, target: toPublicConfig(config) });
        position = await ledgerPosition(wallet, active);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        logUpstreamError(error, requestId, "reservationStore");
        throw new ApiError(503, "ELIGIBILITY_UNAVAILABLE", "Genesis ownership could not be verified on Avalanche C-Chain.");
      }
      if (!heldIds(position.balances).length) throw new ApiError(403, "ACCESS_DENIED", "This wallet does not currently hold Genesis token 0, 1, 2, or 3 on Avalanche C-Chain.");
      const usedTokenId = unitToUse(position.unused);
      if (usedTokenId === null) throw new ApiError(403, "GENESIS_HOLDING_ALREADY_USED", "Every Genesis unit in this wallet was already used for a free claim by a previous holder.");
      if (config.allocation !== 0n && BigInt(claimState.claimedSupply) >= config.allocation) throw new ApiError(409, "CLAIM_ALLOCATION_EXHAUSTED", "The reserved Genesis claim allocation has been exhausted.");
      try {
        const voucher = Object.freeze({
          claimant: wallet,
          genesisContract: GENESIS_CONTRACT,
          genesisChainId: GENESIS_CHAIN_ID,
          eligibilityRule: config.eligibilityRule,
          destinationChainId: config.destinationChainId,
          releaseContract: config.releaseContract,
          tokenId: config.tokenId.toString(),
          quantity: "1",
          allocation: config.allocation.toString(),
          nonce: nonce().toString(),
          // Short-lived, and never past the claim window.
          deadline: String(BigInt(Math.min(clock() + VOUCHER_LIFETIME_SECONDS, Number(config.claimEnd) - 1))),
        });
        const domain = {
          name: "The Void Genesis Holder Claim",
          version: "1",
          chainId: config.destinationChainId,
          verifyingContract: config.claimContract,
        };
        const signature = await claimSigner.signTypedData(domain, VOUCHER_TYPES, voucher);
        // Off-chain accounting only: one unused Genesis unit (lowest ID) counts as used by this claim. No
        // Genesis token is moved, burned, locked or approved; the wallet's other units stay unused.
        await tx.upsert({ claimContract: config.claimContract, wallet, block: position.head, usedTokenId, balances: position.balances, deadline: BigInt(voucher.deadline), status: "PENDING", voucher, signature });
        return Object.freeze({ voucher, signature, target: toPublicConfig(config) });
      } catch (error) {
        logUpstreamError(error, requestId, "signOrRecord");
        throw new ApiError(503, "CLAIM_AUTHORIZATION_UNAVAILABLE", "Claim authorization could not be issued for the configured destination.");
      }
    });
  }

  /**
   * Early access for the one configured wallet: no Genesis holding is read and no used-unit ledger entry
   * is written. Nothing is stored either; the contract's earlyAccessClaimed flag allows one mint however
   * many vouchers are issued, and a failed transaction leaves it unset so the wallet can request again.
   */
  async function issueEarlyAccessVoucher(walletInput) {
    const early = config.earlyAccess;
    if (!early) throw new ApiError(409, "EARLY_ACCESS_UNAVAILABLE", "Early access is not enabled.");
    const wallet = assertWallet(walletInput);
    if (wallet !== early.wallet) throw new ApiError(403, "ACCESS_DENIED", "This wallet is not approved for early access.");
    const now = BigInt(clock());
    if (now < early.start) throw new ApiError(409, "EARLY_ACCESS_NOT_OPEN", "Early access has not opened yet.");
    if (now >= early.end) throw new ApiError(409, "EARLY_ACCESS_CLOSED", "Early access has closed.");
    let onChain;
    try {
      if (bindingReader) await bindingReader();
      else await verifyContractBindings();
      const [chainWallet, chainStart, chainEnd, enabled, claimed] = earlyAccessStateReader
        ? await earlyAccessStateReader()
        : await Promise.all([claim.earlyAccessWallet(), claim.earlyAccessStart(), claim.earlyAccessEnd(), claim.earlyAccessEnabled(), claim.earlyAccessClaimed()]);
      onChain = { chainWallet, chainStart, chainEnd, enabled, claimed };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "CLAIM_AUTHORIZATION_UNAVAILABLE", "Claim authorization could not be issued for the configured destination.");
    }
    if (!onChain.enabled || getAddress(onChain.chainWallet) !== early.wallet || BigInt(onChain.chainStart) !== early.start || BigInt(onChain.chainEnd) !== early.end) {
      throw new ApiError(503, "CLAIM_BINDING_MISMATCH", "The on-chain early-access configuration does not match the authorized target.");
    }
    if (onChain.claimed) throw new ApiError(409, "ALREADY_CLAIMED", "The early-access mint has already been used.");
    try {
      const voucher = Object.freeze({
        claimant: wallet,
        destinationChainId: config.destinationChainId,
        releaseContract: config.releaseContract,
        tokenId: config.tokenId.toString(),
        quantity: "1",
        windowStart: early.start.toString(),
        windowEnd: early.end.toString(),
        nonce: nonce().toString(),
        deadline: String(BigInt(Math.min(clock() + VOUCHER_LIFETIME_SECONDS, Number(early.end) - 1))),
      });
      const domain = { name: "The Void Genesis Holder Claim", version: "1", chainId: config.destinationChainId, verifyingContract: config.claimContract };
      const signature = await claimSigner.signTypedData(domain, EARLY_ACCESS_VOUCHER_TYPES, voucher);
      return Object.freeze({ voucher, signature, target: toPublicConfig(config) });
    } catch {
      throw new ApiError(503, "CLAIM_AUTHORIZATION_UNAVAILABLE", "Claim authorization could not be issued for the configured destination.");
    }
  }

  return Object.freeze({
    config: toPublicConfig(config),
    checkEligibility,
    issueVoucher,
    issueEarlyAccessVoucher,
    verifyContractBindings,
  });
}
