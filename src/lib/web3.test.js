import { describe, it, expect } from "vitest";
import {
  isValidAddress,
  shortAddr,
  ipfsToHttp,
  encodeTransfer,
  waitForReceipt,
  isOwned,
  encodeBridgeApproval,
  encodeBridgeTokens,
  encodeBridgeBack,
  bridgeRoute,
  CONTRACTS,
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

describe("encodeBridgeApproval", () => {
  it("starts with the setApprovalForAll selector and approves the bridge source", () => {
    const data = encodeBridgeApproval();
    expect(data.startsWith("0xa22cb465")).toBe(true);
    const body = data.slice(10);
    const words = body.match(/.{1,64}/g);
    expect(words).toHaveLength(2);
    expect(words[0].endsWith(CONTRACTS.bridgeSource.toLowerCase().replace("0x", ""))).toBe(true);
    expect(BigInt("0x" + words[1])).toBe(1n);
  });
});

describe("encodeBridgeTokens", () => {
  const recipient = "0x2222222222222222222222222222222222222222";
  const data = encodeBridgeTokens([1, 2], recipient);

  it("starts with the bridgeTokens selector", () => {
    expect(data.startsWith("0xb33fecbf")).toBe(true);
  });

  it("encodes offsets, recipient, token ids, and amounts", () => {
    const body = data.slice(10);
    const words = body.match(/.{1,64}/g);
    // tokenIdsOffset, amountsOffset, recipient, tokenIds.length, id0, id1, amounts.length, amt0, amt1
    expect(words).toHaveLength(9);
    expect(BigInt("0x" + words[0])).toBe(96n); // tokenIdsOffset = 3 * 32
    expect(BigInt("0x" + words[1])).toBe(192n); // amountsOffset = 96 + 32 + 2*32
    expect(words[2].endsWith(recipient.toLowerCase().replace("0x", ""))).toBe(true);
    expect(BigInt("0x" + words[3])).toBe(2n);
    expect(BigInt("0x" + words[4])).toBe(1n);
    expect(BigInt("0x" + words[5])).toBe(2n);
    expect(BigInt("0x" + words[6])).toBe(2n);
    expect(BigInt("0x" + words[7])).toBe(1n);
    expect(BigInt("0x" + words[8])).toBe(1n);
  });
});

describe("encodeBridgeBack", () => {
  it("starts with the bridgeBack selector", () => {
    const data = encodeBridgeBack([3], "0x1111111111111111111111111111111111111111");
    expect(data.startsWith("0xf7c65f85")).toBe(true);
  });
});

describe("bridgeRoute", () => {
  it("routes cchain-to-grotto from C-Chain to The Grotto", () => {
    const { from, to } = bridgeRoute("cchain-to-grotto");
    expect(from.key).toBe("cchain");
    expect(to.key).toBe("grotto");
  });
  it("routes grotto-to-cchain from The Grotto to C-Chain", () => {
    const { from, to } = bridgeRoute("grotto-to-cchain");
    expect(from.key).toBe("grotto");
    expect(to.key).toBe("cchain");
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
