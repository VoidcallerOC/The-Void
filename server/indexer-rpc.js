import { marketplaceInterface } from "./marketplace-events.js";

function hex(value) { return `0x${BigInt(value).toString(16)}`; }

/** Structured RPC transport failure so retries can honor status + Retry-After. */
export class RpcHttpError extends Error {
  constructor(status, { retryAfterMs = null, method = null } = {}) {
    super(`RPC HTTP ${status}`);
    this.name = "RpcHttpError";
    this.status = Number(status);
    this.retryAfterMs = retryAfterMs == null ? null : Number(retryAfterMs);
    this.retryable = this.status === 429 || this.status >= 500;
    if (method) this.rpcMethod = method;
  }
}

/** Parse Retry-After as delta-seconds or HTTP-date into milliseconds. */
export function parseRetryAfterMs(headerValue, now = Date.now()) {
  if (headerValue == null || headerValue === "") return null;
  const text = String(headerValue).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    return Math.round(seconds * 1000);
  }
  const when = Date.parse(text);
  if (!Number.isFinite(when)) return null;
  return Math.max(0, when - Number(now));
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? headers.get(name.toUpperCase());
  }
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? null;
}

function markRetryable(error, { retryable = true } = {}) {
  if (error && typeof error === "object") error.retryable = retryable;
  return error;
}

/** Default number of consecutive priority calls served before a waiting normal call takes the next slot. */
export const DEFAULT_PACER_MAX_CONSECUTIVE_PRIORITY = 3;

/**
 * Serializes RPC work and spaces requests so free public endpoints are not
 * re-tripped immediately after a successful call or Retry-After wait.
 *
 * After a 429, success-path spacing is elevated for the Retry-After window so
 * catch-up does not immediately re-burn the shared free-tier quota.
 *
 * Two lanes share ONE gate. A call scheduled with `priority: true` (settlement
 * reconciliation) takes the next free slot ahead of queued normal calls (the
 * block scan), but it never runs before `nextAllowedAt`: the minimum spacing,
 * the post-429 spacing and the Retry-After gate apply to both lanes alike, so
 * the provider sees exactly the same request rate as before. Fairness: after
 * `maxConsecutivePriority` priority calls in a row, a waiting normal call is
 * served next, so the scan cannot be starved by a burst of settlements.
 */
export function createRpcRequestPacer({
  minIntervalMs = 5_000,
  rateLimitCooldownMs = 45_000,
  maxDelayMs = 60_000,
  postRateLimitIntervalMs = 10_000,
  maxConsecutivePriority = DEFAULT_PACER_MAX_CONSECUTIVE_PRIORITY,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  onWait = null,
} = {}) {
  const safeMin = Math.max(0, Number(minIntervalMs) || 0);
  const safeCooldown = Math.max(0, Number(rateLimitCooldownMs) || 0);
  const safeMax = Math.max(safeCooldown, Number(maxDelayMs) || 0);
  const safePenalty = Math.max(safeMin, Number(postRateLimitIntervalMs) || 0);
  const fairnessWindow = Math.max(1, Number(maxConsecutivePriority) || DEFAULT_PACER_MAX_CONSECUTIVE_PRIORITY);
  const queues = { priority: [], normal: [] };
  let pumping = false;
  let consecutivePriority = 0;
  let nextAllowedAt = 0;
  let rateLimitGateUntil = 0;
  let elevatedUntil = 0;
  let elevatedIntervalMs = safeMin;

  function bump(delayMs) {
    const wait = Math.max(0, Math.min(safeMax, Number(delayMs) || 0));
    nextAllowedAt = Math.max(nextAllowedAt, now() + wait);
  }

  function activeIntervalMs() {
    return now() < elevatedUntil ? elevatedIntervalMs : safeMin;
  }

  function noteSuccess() {
    const interval = activeIntervalMs();
    // Full jitter on the success path so catch-up traffic is not periodic.
    const jittered = Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * (interval + 1));
    bump(Math.max(interval, jittered));
  }

  function noteRateLimit(retryAfterMs = null) {
    const raw = retryAfterMs == null || retryAfterMs === "" ? NaN : Number(retryAfterMs);
    const fromHeader = Number.isFinite(raw) && raw >= 0 ? raw : NaN;
    const delay = Number.isFinite(fromHeader) ? Math.max(safeCooldown, fromHeader) : safeCooldown;
    bump(delay);
    rateLimitGateUntil = Math.max(rateLimitGateUntil, nextAllowedAt);
    // Stay elevated past the gate so the first recovered calls do not use the tight success interval.
    elevatedIntervalMs = Math.max(safeMin, Math.min(safeMax, safePenalty));
    elevatedUntil = Math.max(elevatedUntil, nextAllowedAt + elevatedIntervalMs);
  }

  function waitReason() {
    const at = now();
    if (at < rateLimitGateUntil) return "retry_after";
    if (at < elevatedUntil) return "post_rate_limit";
    return "spacing";
  }

  // Priority first, unless the fairness window is spent and a normal call is waiting.
  function dequeue() {
    const normalWaiting = queues.normal.length > 0;
    if (queues.priority.length && (!normalWaiting || consecutivePriority < fairnessWindow)) {
      consecutivePriority += 1;
      return queues.priority.shift();
    }
    consecutivePriority = 0;
    return queues.normal.shift() || queues.priority.shift() || null;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      let job;
      while ((job = dequeue())) {
        const wait = Math.max(0, nextAllowedAt - now());
        if (wait > 0) {
          await onWait?.({ waitMs: wait, nextAllowedAt, method: job.method, priority: job.priority, reason: waitReason() });
          await sleep(wait);
        }
        try {
          const result = await job.operation();
          noteSuccess();
          job.resolve(result);
        } catch (error) {
          if (error?.status === 429 || /RPC HTTP 429/i.test(String(error?.message || ""))) {
            noteRateLimit(error?.retryAfterMs);
          }
          job.reject(error);
        }
      }
    } finally {
      pumping = false;
      if (queues.priority.length || queues.normal.length) void pump();
    }
  }

  function schedule(operation, { priority = false, method = null } = {}) {
    return new Promise((resolve, reject) => {
      (priority ? queues.priority : queues.normal).push({ operation, resolve, reject, method, priority: Boolean(priority) });
      void pump();
    });
  }

  return {
    schedule,
    noteSuccess,
    noteRateLimit,
    getNextAllowedAt: () => nextAllowedAt,
    getElevatedUntil: () => elevatedUntil,
    getActiveIntervalMs: () => activeIntervalMs(),
    getQueueDepth: () => ({ priority: queues.priority.length, normal: queues.normal.length }),
  };
}

export function createJsonRpcClient({
  url,
  fetchImpl = fetch,
  timeoutMs = 15000,
  minIntervalMs = 5_000,
  rateLimitCooldownMs = 45_000,
  maxDelayMs = 60_000,
  postRateLimitIntervalMs = 10_000,
  maxConsecutivePriority = DEFAULT_PACER_MAX_CONSECUTIVE_PRIORITY,
  pacer = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  onWait = null,
} = {}) {
  if (!url) throw new TypeError("RPC URL is required.");
  let requestId = 0;
  const resolvedPacer = pacer || createRpcRequestPacer({
    minIntervalMs,
    rateLimitCooldownMs,
    maxDelayMs,
    postRateLimitIntervalMs,
    maxConsecutivePriority,
    now,
    sleep,
    random,
    onWait,
  });

  async function call(method, params, { priority = false } = {}) {
    return resolvedPacer.schedule(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
            signal: controller.signal,
          });
        } catch (error) {
          if (error?.name === "AbortError") throw tagMethod(markRetryable(error), method);
          const wrapped = markRetryable(new Error(error?.message || "RPC network error"));
          wrapped.name = "RpcNetworkError";
          wrapped.cause = error;
          throw tagMethod(wrapped, method);
        }
        if (!response.ok) {
          throw new RpcHttpError(response.status, {
            retryAfterMs: parseRetryAfterMs(headerValue(response.headers, "retry-after")),
            method,
          });
        }
        const body = await response.json();
        if (body.error) throw tagMethod(markRetryable(new Error(body.error.message || `RPC ${method} failed`), { retryable: true }), method);
        return body.result;
      } finally {
        clearTimeout(timer);
      }
    }, { priority, method });
  }

  // The method name rides on every error so retry and rate-limit logs can attribute a failure without any payload.
  function tagMethod(error, method) {
    if (error && typeof error === "object" && !error.rpcMethod) error.rpcMethod = method;
    return error;
  }

  function api(priority) {
    return {
      pacer: resolvedPacer,
      priority,
      /** The same client on the priority lane of the same pacer: same spacing, same Retry-After gate, earlier slot. */
      prioritized() { return priority ? this : api(true); },
      async getBlockNumber() { return Number(BigInt(await call("eth_blockNumber", [], { priority }))); },
      async getLogs({ address, fromBlock, toBlock, topics = undefined }) {
        return (await call("eth_getLogs", [{
          address,
          fromBlock: hex(fromBlock),
          toBlock: hex(toBlock),
          ...(topics ? { topics } : {}),
        }], { priority })).map((log) => ({
          ...log,
          blockNumber: Number(BigInt(log.blockNumber)),
          logIndex: Number(BigInt(log.logIndex)),
        }));
      },
      async getBlock(_chainId, blockNumber) {
        const block = await call("eth_getBlockByNumber", [hex(blockNumber), false], { priority });
        if (!block) throw new Error(`Block ${blockNumber} was not found.`);
        return {
          number: Number(BigInt(block.number)),
          hash: block.hash,
          parentHash: block.parentHash,
          timestamp: Number(BigInt(block.timestamp)),
        };
      },
      async getTransactionReceipt({ transactionHash }) { return call("eth_getTransactionReceipt", [transactionHash], { priority }); },
      async getMarketplaceListing({ marketplaceAddress, listingId, blockTag = "finalized" }) {
        return call("eth_call", [{ to: marketplaceAddress, data: marketplaceInterface.encodeFunctionData("getListing", [listingId]) }, blockTag], { priority });
      },
      async getBalanceOf({ address, contractAddress, tokenId, blockTag = "latest" }) {
        const data = `0x00fdd58e${address.slice(2).padStart(64, "0")}${BigInt(tokenId).toString(16).padStart(64, "0")}`;
        return BigInt(await call("eth_call", [{ to: contractAddress, data }, blockTag], { priority }));
      },
    };
  }

  return api(false);
}
