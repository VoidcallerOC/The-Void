import { describe, expect, it, vi } from "vitest";
import {
  connectWithReleaseChain,
  shouldEnsureChainBeforeAccounts,
} from "./wallet-connect-flow.js";
import { RELEASE_DEPLOYMENT } from "../../config/release-network.js";

describe("shouldEnsureChainBeforeAccounts", () => {
  it("is false for fresh connects (no permission) so Rabby Connect is not opened via switch", () => {
    expect(shouldEnsureChainBeforeAccounts([])).toBe(false);
    expect(shouldEnsureChainBeforeAccounts(null)).toBe(false);
  });

  it("is true when accounts are already authorized (reconnect can switch before re-prompt)", () => {
    expect(shouldEnsureChainBeforeAccounts(["0x1111111111111111111111111111111111111111"])).toBe(true);
  });
});

describe("connectWithReleaseChain", () => {
  const targetHex = String(RELEASE_DEPLOYMENT.chainHexId).toLowerCase();

  it("fresh Rabby-shaped connect: eth_requestAccounts before switch; refuses auth path when post-switch chain stays Ethereum", async () => {
    let chain = "0x1";
    const methods = [];
    const provider = {
      request: vi.fn(async ({ method, params }) => {
        methods.push(method);
        if (method === "eth_accounts") return [];
        if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"];
        if (method === "eth_chainId") return chain;
        if (method === "wallet_switchEthereumChain") {
          // Rabby no-op pattern before site exists: switch "succeeds" but chain unchanged
          // until a Connect site record exists. After accounts we simulate stickiness.
          if (methods.includes("eth_requestAccounts")) chain = params[0].chainId;
          return null;
        }
        throw new Error(`unexpected ${method}`);
      }),
    };

    const result = await connectWithReleaseChain(provider);
    expect(result.chainId).toBe(Number(RELEASE_DEPLOYMENT.chainId));
    expect(methods.indexOf("eth_requestAccounts")).toBeLessThan(methods.indexOf("wallet_switchEthereumChain"));
    expect(methods[0]).toBe("eth_accounts");
  });

  it("does not call wallet_switchEthereumChain before eth_requestAccounts on a fresh connect", async () => {
    let chain = "0x1";
    const methods = [];
    const provider = {
      request: vi.fn(async ({ method, params }) => {
        methods.push(method);
        if (method === "eth_accounts") return [];
        if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"];
        if (method === "eth_chainId") return chain;
        if (method === "wallet_switchEthereumChain") {
          chain = params[0].chainId;
          return null;
        }
        throw new Error(`unexpected ${method}`);
      }),
    };
    await connectWithReleaseChain(provider);
    const firstSwitch = methods.indexOf("wallet_switchEthereumChain");
    const firstAccounts = methods.indexOf("eth_requestAccounts");
    expect(firstAccounts).toBeGreaterThanOrEqual(0);
    expect(firstSwitch).toBeGreaterThan(firstAccounts);
  });

  it("reconnect: ensures release chain before eth_requestAccounts when eth_accounts is non-empty", async () => {
    let chain = "0x1";
    const methods = [];
    const provider = {
      request: vi.fn(async ({ method, params }) => {
        methods.push(method);
        if (method === "eth_accounts") return ["0x1111111111111111111111111111111111111111"];
        if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"];
        if (method === "eth_chainId") return chain;
        if (method === "wallet_switchEthereumChain") {
          chain = params[0].chainId;
          return null;
        }
        throw new Error(`unexpected ${method}`);
      }),
    };
    await connectWithReleaseChain(provider);
    expect(methods.indexOf("wallet_switchEthereumChain")).toBeLessThan(methods.indexOf("eth_requestAccounts"));
    expect(methods.filter((m) => m === "wallet_switchEthereumChain").length).toBeGreaterThanOrEqual(1);
  });

  it("rejects when user refuses the post-accounts switch and does not return success", async () => {
    const provider = {
      request: vi.fn(async ({ method }) => {
        if (method === "eth_accounts") return [];
        if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"];
        if (method === "eth_chainId") return "0x1";
        if (method === "wallet_switchEthereumChain") {
          const error = new Error("User rejected the request.");
          error.code = 4001;
          throw error;
        }
        throw new Error(`unexpected ${method}`);
      }),
    };
    await expect(connectWithReleaseChain(provider)).rejects.toMatchObject({ code: "CHAIN_SWITCH_REJECTED" });
  });

  it("rejects when switch appears to succeed but eth_chainId remains Ethereum (Rabby updateConnectSite no-op)", async () => {
    const provider = {
      request: vi.fn(async ({ method }) => {
        if (method === "eth_accounts") return [];
        if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"];
        if (method === "eth_chainId") return "0x1"; // never changes
        if (method === "wallet_switchEthereumChain") return null;
        throw new Error(`unexpected ${method}`);
      }),
    };
    await expect(connectWithReleaseChain(provider)).rejects.toMatchObject({
      code: "WRONG_CHAIN",
      expectedChainId: Number(RELEASE_DEPLOYMENT.chainId),
      currentChainId: 1,
    });
  });

  it("targets the build release chain hex (Fuji or C-Chain)", async () => {
    let chain = "0x1";
    const provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === "eth_accounts") return ["0x1111111111111111111111111111111111111111"];
        if (method === "eth_requestAccounts") return ["0x1111111111111111111111111111111111111111"];
        if (method === "eth_chainId") return chain;
        if (method === "wallet_switchEthereumChain") {
          expect(params[0].chainId).toBe(targetHex);
          chain = params[0].chainId;
          return null;
        }
        throw new Error(`unexpected ${method}`);
      }),
    };
    await connectWithReleaseChain(provider);
  });
});
