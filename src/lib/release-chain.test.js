import { describe, expect, it, vi } from "vitest";
import {
  assertWalletChainId,
  ensureReleaseChain,
  ensureWalletOnChain,
  isOnReleaseChain,
  isReleaseChainGateError,
  readWalletChainId,
  releaseChainDescriptor,
  releaseNetworkRequiredMessage,
  releaseNetworkSwitchLabel,
  toChainHexId,
} from "./release-chain.js";
import { RELEASE_DEPLOYMENT } from "../../config/release-network.js";

function mockProvider(handlers) {
  return {
    request: vi.fn(async (args) => {
      const handler = handlers[args.method];
      if (!handler) throw new Error(`unexpected ${args.method}`);
      return typeof handler === "function" ? handler(args) : handler;
    }),
  };
}

describe("release-chain helpers", () => {
  it("describes the selected release network with Avalanche metadata", () => {
    const descriptor = releaseChainDescriptor(RELEASE_DEPLOYMENT);
    expect(descriptor.chainId).toBe(Number(RELEASE_DEPLOYMENT.chainId));
    expect(descriptor.hexId).toBe(String(RELEASE_DEPLOYMENT.chainHexId).toLowerCase());
    expect(descriptor.token).toBe("AVAX");
    expect(descriptor.rpcUrl).toMatch(/^https:\/\//);
    expect(descriptor.addEthereumChainParameter.nativeCurrency.symbol).toBe("AVAX");
  });

  it("reads and asserts eth_chainId", async () => {
    const provider = mockProvider({ eth_chainId: "0xa86a" });
    await expect(readWalletChainId(provider)).resolves.toBe(43114);
    await expect(assertWalletChainId(provider, 43114, "Avalanche C-Chain")).resolves.toBe(43114);
    await expect(assertWalletChainId(provider, 43113, "Avalanche Fuji")).rejects.toMatchObject({
      code: "WRONG_CHAIN",
      expectedChainId: 43113,
      currentChainId: 43114,
    });
  });

  it("no-ops when the wallet is already on the target chain", async () => {
    const provider = mockProvider({ eth_chainId: RELEASE_DEPLOYMENT.chainHexId });
    await expect(ensureReleaseChain(provider)).resolves.toBe(Number(RELEASE_DEPLOYMENT.chainId));
    expect(provider.request.mock.calls.map(([call]) => call.method)).toEqual(["eth_chainId"]);
  });

  it("switches from Ethereum to the release chain on connect", async () => {
    let chain = "0x1";
    const provider = mockProvider({
      eth_chainId: () => chain,
      wallet_switchEthereumChain: ({ params }) => {
        expect(params[0].chainId).toBe(String(RELEASE_DEPLOYMENT.chainHexId).toLowerCase());
        chain = params[0].chainId;
      },
    });
    await expect(ensureReleaseChain(provider)).resolves.toBe(Number(RELEASE_DEPLOYMENT.chainId));
    expect(provider.request.mock.calls.map(([call]) => call.method)).toEqual([
      "eth_chainId",
      "wallet_switchEthereumChain",
      "eth_chainId",
    ]);
  });

  it("adds the Avalanche network when the wallet does not know it, then verifies", async () => {
    let chain = "0x1";
    const provider = mockProvider({
      eth_chainId: () => chain,
      wallet_switchEthereumChain: () => {
        const error = new Error("Unrecognized chain");
        error.code = 4902;
        throw error;
      },
      wallet_addEthereumChain: ({ params }) => {
        expect(params[0]).toMatchObject({
          chainId: String(RELEASE_DEPLOYMENT.chainHexId).toLowerCase(),
          chainName: RELEASE_DEPLOYMENT.networkName,
          nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
          rpcUrls: [RELEASE_DEPLOYMENT.rpcUrl],
        });
        chain = params[0].chainId;
      },
    });
    await expect(ensureReleaseChain(provider)).resolves.toBe(Number(RELEASE_DEPLOYMENT.chainId));
    expect(provider.request.mock.calls.map(([call]) => call.method)).toEqual([
      "eth_chainId",
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "eth_chainId", // post-add check
      "eth_chainId", // final assert
    ]);
  });

  it("stops on user rejection and does not claim success on the wrong chain", async () => {
    const provider = mockProvider({
      eth_chainId: "0x1",
      wallet_switchEthereumChain: () => {
        const error = new Error("User rejected the request.");
        error.code = 4001;
        throw error;
      },
    });
    await expect(ensureReleaseChain(provider)).rejects.toMatchObject({ code: "CHAIN_SWITCH_REJECTED" });
    expect(provider.request.mock.calls.map(([call]) => call.method)).not.toContain("wallet_addEthereumChain");
  });

  it("refuses to continue when switch appears to succeed but eth_chainId is still wrong", async () => {
    const provider = mockProvider({
      eth_chainId: "0x1",
      wallet_switchEthereumChain: () => undefined,
    });
    await expect(ensureWalletOnChain(provider, { id: 43114, hexId: "0xa86a", name: "Avalanche C-Chain", rpc: "https://api.avax.network/ext/bc/C/rpc" }))
      .rejects.toMatchObject({ code: "WRONG_CHAIN", currentChainId: 1, expectedChainId: 43114 });
  });

  it("encodes hex chain ids for EIP-3326 / EIP-3085", () => {
    expect(toChainHexId(43114)).toBe("0xa86a");
    expect(toChainHexId(43113)).toBe("0xa869");
    expect(toChainHexId(1)).toBe("0x1");
  });

  it("exposes Avalanche-first UX helpers that never name Ethereum as intended", () => {
    expect(isOnReleaseChain(RELEASE_DEPLOYMENT.chainId)).toBe(true);
    expect(isOnReleaseChain(1)).toBe(false);
    expect(isReleaseChainGateError({ code: "WRONG_CHAIN" })).toBe(true);
    expect(isReleaseChainGateError({ code: "CHAIN_SWITCH_REJECTED" })).toBe(true);
    expect(isReleaseChainGateError({ code: 4001 })).toBe(false);
    const message = releaseNetworkRequiredMessage(RELEASE_DEPLOYMENT);
    expect(message).toMatch(new RegExp(String(RELEASE_DEPLOYMENT.chainId)));
    expect(message).toMatch(/Ethereum is not supported/i);
    expect(releaseNetworkSwitchLabel({ networkName: "Avalanche C-Chain", chainId: 43114 })).toBe("SWITCH TO AVALANCHE");
    expect(releaseNetworkSwitchLabel({ networkName: "Avalanche Fuji", chainId: 43113 })).toBe("SWITCH TO FUJI");
  });
});
