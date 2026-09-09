import { randomUUID } from "node:crypto";
import { ApiError } from "./api-errors.js";

export function createRequestId() { return randomUUID(); }

export function createStructuredLogger({ sink = console } = {}) {
  const write = (level, event, fields = {}) => {
    const record = { timestamp: new Date().toISOString(), level, event, ...fields };
    const method = sink[level] || sink.log;
    method.call(sink, JSON.stringify(record));
    return record;
  };
  return { info: (event, fields) => write("info", event, fields), warn: (event, fields) => write("warn", event, fields), error: (event, fields) => write("error", event, fields) };
}

export function createRateLimiter({ limit = 60, windowMs = 60_000, now = () => Date.now() } = {}) {
  const buckets = new Map();
  return {
    check(key) {
      const current = now();
      const bucket = buckets.get(key);
      if (!bucket || current >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: current + windowMs });
        return { allowed: true, remaining: limit - 1, resetAt: current + windowMs };
      }
      if (bucket.count >= limit) throw new ApiError(429, "RATE_LIMITED", "Too many requests. Try again later.", { resetAt: bucket.resetAt });
      bucket.count += 1;
      return { allowed: true, remaining: limit - bucket.count, resetAt: bucket.resetAt };
    },
  };
}

export async function requireWalletAuth(authenticator, request) {
  if (typeof authenticator !== "function") throw new ApiError(501, "AUTH_NOT_CONFIGURED", "Wallet authentication is not configured.");
  const identity = await authenticator(request);
  if (!identity?.wallet) throw new ApiError(401, "UNAUTHORIZED", "A verified wallet signature is required.");
  return { ...identity, wallet: identity.wallet.toLowerCase() };
}

export function assertWalletMatches(identity, wallet, field = "wallet") {
  if (!identity?.wallet || identity.wallet !== String(wallet || "").toLowerCase()) throw new ApiError(403, "WALLET_MISMATCH", `${field} does not match the authenticated wallet.`);
}
