export const zeroAddress = "0x0000000000000000000000000000000000000000";

export function normalizeBlockTimestamp(value) {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("Block timestamp is invalid.");
  return new Date(seconds * 1000);
}

/** HTTP 429 / 5xx and transport failures are worth retrying; other 4xx are not. */
export function isRetryableRpcError(error) {
  if (!error) return false;
  if (error.retryable === true) return true;
  if (error.retryable === false) return false;
  if (typeof error.status === "number") return error.status === 429 || error.status >= 500;
  const message = String(error.message || "");
  const httpStatus = /RPC HTTP (\d+)/i.exec(message);
  if (httpStatus) {
    const status = Number(httpStatus[1]);
    return status === 429 || status >= 500;
  }
  if (error.name === "AbortError") return true;
  if (/aborted|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up/i.test(message)) return true;
  // Preserve prior behavior for opaque transient RPC failures (e.g. "RPC down").
  return true;
}

function isRateLimitError(error) {
  if (!error) return false;
  if (error.status === 429) return true;
  return /RPC HTTP 429/i.test(String(error.message || ""));
}

/**
 * Bounded exponential backoff with full jitter.
 * Respects Retry-After when present (capped by maxDelayMs).
 * Rate limits without Retry-After use a higher exponential floor so short
 * defaults (250ms base) do not storm the public Avalanche RPC.
 */
export function computeRetryDelayMs({
  attempt = 0,
  baseDelayMs = 20,
  maxDelayMs = 30_000,
  error = null,
  random = Math.random,
} = {}) {
  const safeBase = Math.max(0, Number(baseDelayMs) || 0);
  const safeMax = Math.max(0, Number(maxDelayMs) || 0);
  const rateLimited = isRateLimitError(error);
  const effectiveBase = rateLimited ? Math.max(safeBase, 1_000) : safeBase;
  const expAttempt = rateLimited ? attempt + 2 : attempt;
  const exponential = Math.min(safeMax, effectiveBase * (2 ** expAttempt));
  let delay = Math.floor(Math.max(0, Math.min(1, Number(random()) || 0)) * (exponential + 1));

  const rawRetryAfter = error?.retryAfterMs;
  const retryAfterMs = rawRetryAfter == null || rawRetryAfter === "" ? NaN : Number(rawRetryAfter);
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    delay = Math.max(delay, Math.min(safeMax, retryAfterMs));
  } else if (rateLimited) {
    delay = Math.max(delay, Math.min(safeMax, Math.floor(exponential / 2)));
  }
  return Math.min(safeMax, delay);
}

export function retry(operation, {
  retries = 4,
  baseDelayMs = 20,
  maxDelayMs = 30_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRetry = () => {},
  random = Math.random,
  shouldRetry = isRetryableRpcError,
} = {}) {
  return (async () => {
    let attempt = 0;
    while (true) {
      try { return await operation(); } catch (error) {
        if (attempt >= retries || !shouldRetry(error)) throw error;
        const delay = computeRetryDelayMs({ attempt, baseDelayMs, maxDelayMs, error, random });
        attempt += 1;
        await onRetry({ attempt, delay, error });
        if (delay > 0) await sleep(delay);
      }
    }
  })();
}
