import { describe, expect, it, vi } from "vitest";
import { createJsonRpcClient, createRpcRequestPacer, parseRetryAfterMs, RpcHttpError } from "./indexer-rpc.js";
import { computeRetryDelayMs, isRetryableRpcError, retry } from "./indexer-utils.js";

const instantClient = (overrides = {}) => createJsonRpcClient({
  url: "https://rpc.example",
  minIntervalMs: 0,
  rateLimitCooldownMs: 1,
  maxDelayMs: 1,
  ...overrides,
});

describe("indexer JSON-RPC client", () => {
  it("aborts a stalled request at the configured timeout", async () => {
    const fetchImpl = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("request aborted"), { name: "AbortError" })));
    }));
    const client = instantClient({ timeoutMs: 5, fetchImpl });
    await expect(client.getBlockNumber(43113)).rejects.toThrow(/aborted/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns normalized block and log values from valid RPC responses", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ result: "0x2a" }) })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ result: [{ blockNumber: "0x2a", logIndex: "0x3" }] }) });
    const client = instantClient({ fetchImpl });
    await expect(client.getBlockNumber(43113)).resolves.toBe(42);
    await expect(client.getLogs({ chainId: 43113, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", fromBlock: 40, toBlock: 42 })).resolves.toEqual([{ blockNumber: 42, logIndex: 3 }]);
  });

  it("throws RpcHttpError with Retry-After for HTTP 429 responses", async () => {
    const headers = { get: vi.fn((name) => (String(name).toLowerCase() === "retry-after" ? "12" : null)) };
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429, headers });
    const client = instantClient({ fetchImpl });
    await expect(client.getBlockNumber()).rejects.toMatchObject({ name: "RpcHttpError", status: 429, retryAfterMs: 12_000, retryable: true, message: "RPC HTTP 429" });
  });

  it("marks transient 5xx and network failures as retryable", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, headers: { get: () => null } })
      .mockRejectedValueOnce(new Error("fetch failed"));
    const client = instantClient({ fetchImpl });
    await expect(client.getBlockNumber()).rejects.toMatchObject({ status: 503, retryable: true });
    await expect(client.getBlockNumber()).rejects.toMatchObject({ name: "RpcNetworkError", retryable: true });
  });

  it("does not mark permanent 4xx responses as retryable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400, headers: { get: () => null } });
    const client = instantClient({ fetchImpl });
    await expect(client.getBlockNumber()).rejects.toMatchObject({ status: 400, retryable: false });
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds and HTTP-date Retry-After values", () => {
    expect(parseRetryAfterMs("7")).toBe(7_000);
    expect(parseRetryAfterMs("1.5")).toBe(1_500);
    const now = Date.parse("Thu, 01 Jan 2026 00:00:00 GMT");
    expect(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5_000);
    expect(parseRetryAfterMs("not-a-value")).toBeNull();
  });
});

describe("RPC request pacer", () => {
  it("serializes overlapping RPC calls through one queue", async () => {
    const order = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const pacer = createRpcRequestPacer({ minIntervalMs: 0, rateLimitCooldownMs: 1, maxDelayMs: 1, sleep: async () => {} });
    const first = pacer.schedule(async () => {
      order.push("start-1");
      await firstGate;
      order.push("end-1");
      return 1;
    });
    const second = pacer.schedule(async () => {
      order.push("start-2");
      order.push("end-2");
      return 2;
    });
    await Promise.resolve();
    expect(order).toEqual(["start-1"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("enforces a minimum interval between successful calls", async () => {
    const sleeps = [];
    let clock = 1_000;
    const pacer = createRpcRequestPacer({
      minIntervalMs: 1_500,
      rateLimitCooldownMs: 45_000,
      maxDelayMs: 60_000,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      random: () => 0,
    });
    await pacer.schedule(async () => "a");
    await pacer.schedule(async () => "b");
    expect(sleeps).toEqual([1_500]);
  });

  it("extends the next-allowed time on HTTP 429 using the cooldown floor", async () => {
    let clock = 5_000;
    const sleeps = [];
    const pacer = createRpcRequestPacer({
      minIntervalMs: 100,
      rateLimitCooldownMs: 45_000,
      maxDelayMs: 60_000,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      random: () => 0,
    });
    await expect(pacer.schedule(async () => {
      throw new RpcHttpError(429, { retryAfterMs: 12_000 });
    })).rejects.toMatchObject({ status: 429 });
    await pacer.schedule(async () => "recovered");
    expect(sleeps[0]).toBe(45_000);
  });

  it("honors a Retry-After longer than the cooldown floor", async () => {
    let clock = 0;
    const sleeps = [];
    const pacer = createRpcRequestPacer({
      minIntervalMs: 0,
      rateLimitCooldownMs: 10_000,
      maxDelayMs: 60_000,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      random: () => 0,
    });
    await expect(pacer.schedule(async () => {
      throw new RpcHttpError(429, { retryAfterMs: 55_000 });
    })).rejects.toMatchObject({ status: 429 });
    await pacer.schedule(async () => "ok");
    expect(sleeps[0]).toBe(55_000);
  });

  it("spaces client calls so concurrent getLogs work cannot overlap on the wire", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, json: async () => ({ result: "0x1" }) };
    });
    const client = instantClient({ fetchImpl, minIntervalMs: 0 });
    await Promise.all([client.getBlockNumber(), client.getBlockNumber(), client.getBlockNumber()]);
    expect(maxInFlight).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("RPC retry backoff", () => {
  it("applies bounded exponential backoff with jitter for HTTP 429", async () => {
    const sleeps = [];
    let attempts = 0;
    const randomValues = [0.5, 0.25, 1];
    await expect(retry(async () => {
      attempts += 1;
      if (attempts < 3) throw new RpcHttpError(429);
      return "ok";
    }, {
      retries: 4,
      baseDelayMs: 250,
      maxDelayMs: 30_000,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => randomValues.shift() ?? 0,
    })).resolves.toBe("ok");
    expect(attempts).toBe(3);
    // Rate-limit floor uses effectiveBase>=1000 and attempt+2 → caps 4000 then 8000 before jitter.
    expect(sleeps[0]).toBeGreaterThanOrEqual(2_000);
    expect(sleeps[0]).toBeLessThanOrEqual(4_000);
    expect(sleeps[1]).toBeGreaterThanOrEqual(4_000);
    expect(sleeps[1]).toBeLessThanOrEqual(8_000);
  });

  it("defers 429 delay to the pacer instead of stacking another Retry-After sleep", async () => {
    const sleeps = [];
    let attempts = 0;
    await expect(retry(async () => {
      attempts += 1;
      if (attempts === 1) throw new RpcHttpError(429, { retryAfterMs: 30_000 });
      return "ok";
    }, {
      retries: 2,
      baseDelayMs: 250,
      maxDelayMs: 60_000,
      deferRateLimitDelay: true,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0,
    })).resolves.toBe("ok");
    // delay 0 skips sleep(); pacer owns the real cooldown.
    expect(sleeps).toEqual([]);
    expect(computeRetryDelayMs({
      attempt: 0,
      error: new RpcHttpError(429, { retryAfterMs: 30_000 }),
      deferRateLimitDelay: true,
      random: () => 0,
    })).toBe(0);
  });

  it("honors Retry-After when longer than the jittered exponential delay", async () => {
    const sleeps = [];
    let attempts = 0;
    await expect(retry(async () => {
      attempts += 1;
      if (attempts === 1) throw new RpcHttpError(429, { retryAfterMs: 12_500 });
      return "ok";
    }, {
      retries: 2,
      baseDelayMs: 250,
      maxDelayMs: 30_000,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0,
    })).resolves.toBe("ok");
    expect(sleeps).toEqual([12_500]);
  });

  it("caps Retry-After at maxDelayMs", () => {
    expect(computeRetryDelayMs({
      attempt: 0,
      baseDelayMs: 250,
      maxDelayMs: 8_000,
      error: new RpcHttpError(429, { retryAfterMs: 60_000 }),
      random: () => 0,
    })).toBe(8_000);
  });

  it("exhausts retries and rethrows the last 429", async () => {
    let attempts = 0;
    await expect(retry(async () => {
      attempts += 1;
      throw new RpcHttpError(429, { retryAfterMs: 1_000 });
    }, {
      retries: 2,
      baseDelayMs: 10,
      maxDelayMs: 1_000,
      sleep: async () => {},
      random: () => 0,
    })).rejects.toMatchObject({ status: 429, message: "RPC HTTP 429" });
    expect(attempts).toBe(3);
  });

  it("does not retry non-retryable HTTP 400 errors", async () => {
    let attempts = 0;
    await expect(retry(async () => {
      attempts += 1;
      throw new RpcHttpError(400);
    }, { retries: 4, baseDelayMs: 10, sleep: async () => {} })).rejects.toMatchObject({ status: 400 });
    expect(attempts).toBe(1);
    expect(isRetryableRpcError(new RpcHttpError(400))).toBe(false);
    expect(isRetryableRpcError(new RpcHttpError(503))).toBe(true);
  });
});
