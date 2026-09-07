import { describe, it, expect } from "vitest";
import {
  isValidAddress,
  shortAddr,
  ipfsToHttp,
  encodeTransfer,
  waitForReceipt,
  isOwned,
} from "./web3.js";

describe("isValidAddress", () => {
  it("accepts a well-formed 0x address", () => {
    expect(isValidAddress("0xd1b4367dd9f235f9ee61878019d66e31511e98ee")).toBe(true);
  });
  it("rejects bad length, missing prefix, and non-hex", () => {
    expect(isValidAddress("0x123")).toBe(false);
    expect(isValidAddress("d1b4367dd9f235f9ee61878019d66e31511e98ee")).toBe(false);
    expect(isValidAddress("0xZZb4367dd9f235f9ee61878019d66e31511e98ee")).toBe(false);
    expect(isValidAddress("")).toBe(false);
  });
});

describe("shortAddr", () => {
  it("truncates the middle", () => {
    expect(shortAddr("0xd1b4367dd9f235f9ee61878019d66e31511e98ee")).toBe("0xd1b4…98ee");
  });
  it("returns empty string for falsy input", () => {
    expect(shortAddr("")).toBe("");
    expect(shortAddr(null)).toBe("");
  });
});

describe("ipfsToHttp", () => {
  it("rewrites ipfs:// to the gateway", () => {
    expect(ipfsToHttp("ipfs://abc/0.gif")).toBe("https://gateway.pinata.cloud/ipfs/abc/0.gif");
  });
  it("passes through http(s) urls and empties falsy", () => {
    expect(ipfsToHttp("https://x/y.png")).toBe("https://x/y.png");
    expect(ipfsToHttp("")).toBe("");
  });
});

describe("encodeTransfer", () => {
  const from = "0x1111111111111111111111111111111111111111";
  const to = "0x2222222222222222222222222222222222222222";
  const data = encodeTransfer(from, to, 3);

  it("starts with the safeTransferFrom selector", () => {
    expect(data.startsWith("0xf242432a")).toBe(true);
  });
  it("encodes from, to, id, amount=1, bytes offset=160, bytes length=0", () => {
    const body = data.slice(10); // strip 0x + 4-byte selector
    const words = body.match(/.{1,64}/g);
    expect(words).toHaveLength(6);
    expect(words[0].endsWith("1111111111111111111111111111111111111111")).toBe(true);
    expect(words[1].endsWith("2222222222222222222222222222222222222222")).toBe(true);
    expect(BigInt("0x" + words[2])).toBe(3n); // token id
    expect(BigInt("0x" + words[3])).toBe(1n); // amount
    expect(BigInt("0x" + words[4])).toBe(160n); // offset to bytes
    expect(BigInt("0x" + words[5])).toBe(0n); // bytes length
  });
});

describe("isOwned", () => {
  it("is true when either chain holds the token", () => {
    const owned = { cchain: new Set([1]), grotto: new Set([2]) };
    expect(isOwned(owned, 1)).toBe(true);
    expect(isOwned(owned, 2)).toBe(true);
    expect(isOwned(owned, 3)).toBe(false);
  });
  it("is false for nullish ownership", () => {
    expect(isOwned(null, 1)).toBe(false);
  });
});

describe("waitForReceipt", () => {
  it("resolves with the receipt once it appears", async () => {
    let calls = 0;
    const provider = {
      request: async ({ method, params }) => {
        expect(method).toBe("eth_getTransactionReceipt");
        expect(params).toEqual(["0xdeadbeef"]);
        calls += 1;
        return calls < 2 ? null : { status: "0x1" };
      },
    };
    const receipt = await waitForReceipt(provider, "0xdeadbeef", { intervalMs: 1, timeoutMs: 1000 });
    expect(receipt.status).toBe("0x1");
    expect(calls).toBe(2);
  });

  it("throws when the receipt never arrives before the deadline", async () => {
    const provider = { request: async () => null };
    await expect(
      waitForReceipt(provider, "0xabc", { intervalMs: 1, timeoutMs: 5 })
    ).rejects.toThrow(/Timed out/);
  });
});
