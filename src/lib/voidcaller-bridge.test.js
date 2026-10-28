import { describe, expect, it, vi } from "vitest";
import {
  BRIDGE_CHAINS,
  BRIDGE_CONTRACTS,
  BRIDGE_SELECTORS,
  encodeApproval,
  encodeBridgeCall,
  executeBridge,
  switchBridgeChain,
  waitForBridgeReceipt,
} from "./voidcaller-bridge.js";

describe("live VOIDCALLER bridge configuration", () => {
  it("preserves the deployed contracts and supported networks", () => {
    expect(BRIDGE_CHAINS.cchain.id).toBe(43114);
    expect(BRIDGE_CHAINS.grotto.id).toBe(36463);
    expect(BRIDGE_CONTRACTS.bridgeSource.toLowerCase()).toBe("0x68539f95fb2758327a9c7ededa1002b0f3ec8992");
    expect(BRIDGE_CONTRACTS.bridgeRemote.toLowerCase()).toBe("0x0d6fa9968aa57295217737379c44ebbc1130b1fa");
  });

  it("encodes the original approval and dynamic bridge arguments", () => {
    expect(encodeApproval()).toBe(`${BRIDGE_SELECTORS.setApprovalForAll}${BRIDGE_CONTRACTS.bridgeSource.slice(2).toLowerCase().padStart(64, "0")}${"1".padStart(64, "0")}`);
    const data = encodeBridgeCall("cchain-to-grotto", [0, 3], [2, 1], "0x1111111111111111111111111111111111111111");
    expect(data.startsWith(BRIDGE_SELECTORS.bridgeTokens)).toBe(true);
    const words = data.slice(10).match(/.{1,64}/g);
    expect(BigInt(`0x${words[0]}`)).toBe(96n);
    expect(BigInt(`0x${words[1]}`)).toBe(192n);
    expect(words[2].endsWith("1111111111111111111111111111111111111111")).toBe(true);
    expect(BigInt(`0x${words[3]}`)).toBe(2n);
    expect(BigInt(`0x${words[4]}`)).toBe(0n);
    expect(BigInt(`0x${words[5]}`)).toBe(3n);
    expect(BigInt(`0x${words[6]}`)).toBe(2n);
    expect(BigInt(`0x${words[7]}`)).toBe(2n);
    expect(BigInt(`0x${words[8]}`)).toBe(1n);
  });
});

describe("bridge provider operations", () => {
  it("adds the exact live chain when switching reports 4902", async () => {
    const provider = { request: vi.fn().mockRejectedValueOnce(Object.assign(new Error("unknown chain"), { code: 4902 })).mockResolvedValueOnce(null) };
    await switchBridgeChain(provider, "grotto");
    expect(provider.request).toHaveBeenNthCalledWith(2, expect.objectContaining({ method: "wallet_addEthereumChain" }));
    expect(provider.request.mock.calls[1][0].params[0]).toMatchObject({ chainId: "0x8e6f", chainName: "The Grotto", rpcUrls: [BRIDGE_CHAINS.grotto.rpc] });
  });

  it("waits for a receipt and rejects reverted receipts", async () => {
    let calls = 0;
    const provider = { request: vi.fn(async () => (++calls === 1 ? null : { status: "0x1" })) };
    await expect(waitForBridgeReceipt(provider, "0xhash", { intervalMs: 1, timeoutMs: 100 })).resolves.toMatchObject({ status: "0x1" });
    const reverted = { request: vi.fn().mockResolvedValue({ status: "0x0" }) };
    await expect(executeBridge({ provider: reverted, account: "0x1111111111111111111111111111111111111111", direction: "grotto-to-cchain", tokenIds: [1], amounts: [1], receiptOptions: { intervalMs: 1 } })).rejects.toThrow(/reverted/);
  });
});
