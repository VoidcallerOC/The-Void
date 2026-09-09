import { describe, expect, it, vi } from "vitest";
import { createJsonRpcClient } from "./indexer-rpc.js";

describe("indexer JSON-RPC client", () => {
  it("aborts a stalled request at the configured timeout", async () => {
    const fetchImpl = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("request aborted"), { name: "AbortError" })));
    }));
    const client = createJsonRpcClient({ url: "https://rpc.example", timeoutMs: 5, fetchImpl });
    await expect(client.getBlockNumber(43113)).rejects.toThrow(/aborted/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns normalized block and log values from valid RPC responses", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ result: "0x2a" }) })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({ result: [{ blockNumber: "0x2a", logIndex: "0x3" }] }) });
    const client = createJsonRpcClient({ url: "https://rpc.example", fetchImpl });
    await expect(client.getBlockNumber(43113)).resolves.toBe(42);
    await expect(client.getLogs({ chainId: 43113, address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", fromBlock: 40, toBlock: 42 })).resolves.toEqual([{ blockNumber: 42, logIndex: 3 }]);
  });
});
