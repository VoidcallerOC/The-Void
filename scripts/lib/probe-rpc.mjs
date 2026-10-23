// JSON-RPC provider for the read-only Fuji / C-Chain probes run by
// .github/workflows/fuji-readonly-probe.yml.
//
// - Endpoint: the caller passes FUJI_RPC_URL / MAINNET_RPC_URL when set (optional
//   repository secrets for a private endpoint), else the public Avalanche endpoint.
//   A private URL usually embeds an API key, so it is never printed: describeRpc()
//   redacts it and it is scrubbed from provider error messages.
// - HTTP 429: retried with bounded exponential backoff that honours Retry-After as
//   seconds. ethers' built-in throttle reads Retry-After as milliseconds; in run 42
//   (2026-10-23) its 12 attempts against Cloudflare's "error code: 1015" were spent
//   in about a second.
// - RPC limit: when a call is still rate limited after the retries, or the endpoint
//   refuses an eth_getLogs range, the probe's output cannot be trusted (several
//   probes treat a failed read as "absent"). Later calls on that chain fail fast,
//   and the process exits with RPC_LIMITED_EXIT_CODE after one UNVERIFIED line per
//   chain on stderr, whatever exit code the probe itself chose. scripts/run-probe.sh
//   reports that exit as UNVERIFIED instead of failing the job.
import { FetchRequest, JsonRpcProvider } from "ethers";

export const PUBLIC_RPC_URLS = Object.freeze({ 43113: "https://api.avax-test.network/ext/bc/C/rpc", 43114: "https://api.avax.network/ext/bc/C/rpc" });
export const RPC_LIMITED_EXIT_CODE = 75; // EX_TEMPFAIL
const CHAINS = { 43113: { name: "Avalanche Fuji", env: "FUJI_RPC_URL" }, 43114: { name: "Avalanche C-Chain", env: "MAINNET_RPC_URL" } };
const REDACTED = "<private RPC endpoint, URL redacted>";
// 5 attempts: waits of 1, 2, 4 and 8 s, or Retry-After when longer, each capped at 10 s
// (at most 40 s per chain per probe, so a storm cannot run the job into its timeout).
export const DEFAULT_RETRY = Object.freeze({ attempts: 5, baseMs: 1000, maxDelayMs: 10000 });

const RATE_LIMIT_TEXT = /too many requests|rate[ -]?limit|error code: 1015|request limit/i;
const RANGE_LIMIT_TEXT = /block range (is )?too (large|wide)|exceeds the maximum of \d+ blocks|query returned more than \d+ results/i;

/** "rate limit", "log range limit" or null, from an HTTP status line and/or response or JSON-RPC error text. */
export function rpcLimitKind({ status = "", text = "" } = {}) {
  if (/(^|\()429\b/.test(status) || RATE_LIMIT_TEXT.test(text)) return "rate limit";
  if (RANGE_LIMIT_TEXT.test(text)) return "log range limit";
  return null;
}

export function retryDelayMs(attempt, retryAfter, retry = DEFAULT_RETRY) {
  const hinted = /^\d+$/.test(String(retryAfter ?? "").trim()) ? Number(retryAfter) * 1000 : 0;
  return Math.min(retry.maxDelayMs, Math.max(retry.baseMs * 2 ** attempt, hinted));
}

export const isPublicRpc = (url) => Object.values(PUBLIC_RPC_URLS).includes(url);
export const describeRpc = (url) => (isPublicRpc(url) ? url : REDACTED);

const limits = new Map();

function reportLimitsOnExit() {
  if (!limits.size) return;
  for (const [chainId, limit] of limits) {
    const chain = CHAINS[chainId] || { name: `chain ${chainId}`, env: "the RPC URL secret" };
    const skipped = limit.skipped ? `; ${limit.skipped} later call(s) not sent` : "";
    console.error(`RPC_LIMIT UNVERIFIED: ${chain.name} (${chainId}) via ${limit.endpoint}: ${limit.kind} (${limit.detail})${skipped}. This probe's output is incomplete and is not a finding. ${isPublicRpc(limit.url) ? `Set the ${chain.env} repository secret to a private endpoint.` : "Check the private endpoint's limits."}`);
  }
  process.exitCode = RPC_LIMITED_EXIT_CODE;
}

function recordLimit(chainId, url, kind, detail) {
  if (!limits.size) process.on("exit", reportLimitsOnExit);
  const known = limits.get(chainId);
  // A rate limit replaces an earlier log range limit so that later calls fail fast.
  if (!known || (kind === "rate limit" && known.kind !== kind)) limits.set(chainId, { kind, detail: scrub(String(detail).replace(/\s+/g, " ").trim().slice(0, 200), url), url, endpoint: describeRpc(url), skipped: 0 });
}

function scrub(text, url) {
  return isPublicRpc(url) || typeof text !== "string" ? text : text.split(url).join(REDACTED);
}

function scrubError(error, url) {
  if (isPublicRpc(url) || !error || typeof error !== "object") return error;
  for (const key of ["message", "stack"]) {
    try { if (typeof error[key] === "string") error[key] = scrub(error[key], url); } catch { /* read-only */ }
  }
  if (error.info?.requestUrl) error.info.requestUrl = REDACTED;
  return error;
}

class ProbeProvider extends JsonRpcProvider {
  #url;
  #chainId;

  constructor(url, chainId, retry) {
    const request = new FetchRequest(url);
    // ethers only retries 429 here; the wait is ours (slotInterval 0 removes its random one).
    request.setThrottleParams({ maxAttempts: retry.attempts, slotInterval: 0 });
    request.retryFunc = async (_request, response, attempt) => {
      if (attempt + 1 >= retry.attempts) return false; // last attempt: surface the 429 now
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt, response.headers["retry-after"], retry)));
      return true;
    };
    super(request, chainId, { staticNetwork: true });
    this.#url = url;
    this.#chainId = chainId;
  }

  async _send(payload) {
    const limit = limits.get(this.#chainId);
    if (limit?.kind === "rate limit") {
      limit.skipped += Array.isArray(payload) ? payload.length : 1;
      throw Object.assign(new Error(`not sent: ${CHAINS[this.#chainId]?.name || this.#chainId} RPC rate limited earlier in this run`), { code: "SERVER_ERROR" });
    }
    try {
      return await super._send(payload);
    } catch (error) {
      const status = String(error?.info?.responseStatus ?? "");
      const body = String(error?.info?.responseBody ?? "");
      const kind = rpcLimitKind({ status, text: body });
      if (kind) recordLimit(this.#chainId, this.#url, kind, `HTTP ${status}${body ? `: ${body}` : ""}`);
      throw scrubError(error, this.#url);
    }
  }

  getRpcError(payload, response) {
    const message = String(response?.error?.message ?? "");
    // A revert reason is contract text, not the endpoint's.
    const kind = /revert/i.test(message) ? null : rpcLimitKind({ text: message });
    if (kind) recordLimit(this.#chainId, this.#url, kind, `${payload?.method}: ${message}`);
    return scrubError(super.getRpcError(payload, response), this.#url);
  }
}

/** Drop-in for `new JsonRpcProvider(url, chainId, { staticNetwork: true })` in the probes. */
export function probeProvider(url, chainId, { retry = DEFAULT_RETRY } = {}) {
  return new ProbeProvider(url, Number(chainId), retry);
}
