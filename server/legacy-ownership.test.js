import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-errors.js";
import { IndexedOwnershipVerifier } from "./ownership.js";
import { MainnetBalanceClient, verifyLegacyMainnetOwnership } from "./legacy-ownership.js";
import { LEGACY_CONTRACT, LEGACY_CHAIN_ID, legacyExperienceId } from "../src/lib/legacy-genesis.js";

const wallet = "0x1111111111111111111111111111111111111111";
const requirement = { type: "erc1155-balance", contract: LEGACY_CONTRACT, tokenIds: ["1"], minAmount: "1", chainId: LEGACY_CHAIN_ID };

function rpcResult(hexAmount) {
  return { ok: true, json: async () => ({ result: hexAmount }) };
}

describe("legacy mainnet ownership", () => {
  it("grants access when mainnet balanceOf is > 0", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rpcResult("0x" + "1".padStart(64, "0")));
    const client = new MainnetBalanceClient({ rpcUrl: "https://api.avax.network/ext/bc/C/rpc", fetchImpl });
    await expect(verifyLegacyMainnetOwnership({ requirement, wallet, client, experienceId: legacyExperienceId(1) })).resolves.toMatchObject({ owns: true, state: "CONFIRMED", chainId: 43114, source: "mainnet-rpc" });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.params[0].to.toLowerCase()).toBe(LEGACY_CONTRACT);
    expect(body.params[0].data.startsWith("0x00fdd58e")).toBe(true);
  });

  it("returns unauthorized for a non-holder", async () => {
    const client = new MainnetBalanceClient({ rpcUrl: "https://api.avax.network/ext/bc/C/rpc", fetchImpl: vi.fn().mockResolvedValue(rpcResult("0x" + "0".padStart(64, "0"))) });
    await expect(verifyLegacyMainnetOwnership({ requirement, wallet, client })).resolves.toMatchObject({ owns: false, state: "UNAUTHORIZED", chainId: 43114 });
  });

  it("fails closed when the requirement is on the wrong chain", async () => {
    const client = new MainnetBalanceClient({ rpcUrl: "https://example.invalid", fetchImpl: vi.fn() });
    await expect(verifyLegacyMainnetOwnership({ requirement: { ...requirement, chainId: 43113 }, wallet, client })).rejects.toMatchObject({ code: "LEGACY_WRONG_CHAIN", status: 403 });
    expect(client.fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the RPC errors", async () => {
    const client = new MainnetBalanceClient({ rpcUrl: "https://api.avax.network/ext/bc/C/rpc", fetchImpl: vi.fn().mockRejectedValue(new Error("socket hang up")) });
    await expect(verifyLegacyMainnetOwnership({ requirement, wallet, client })).rejects.toMatchObject({ code: "MAINNET_RPC_UNAVAILABLE", status: 503 });
  });
});

describe("composite ownership routing", () => {
  it("routes legacy mainnet requirements to the live RPC and Fuji to the indexer", async () => {
    const db = { query: vi.fn() };
    const config = { authAllowedChainIds: [43113], ownershipMaxIndexerLagBlocks: 24, ownershipMaxIndexerStalenessMs: 120_000, mainnetRpcUrl: "https://api.avax.network/ext/bc/C/rpc" };
    const mainnetClient = new MainnetBalanceClient({ rpcUrl: config.mainnetRpcUrl, fetchImpl: vi.fn().mockResolvedValue(rpcResult("0x" + "2".padStart(64, "0"))) });
    const verifier = new IndexedOwnershipVerifier({ db, config, now: () => new Date("2026-09-25T15:00:00.000Z"), mainnetClient });
    await expect(verifier.verify({ wallet, experienceId: "voidcaller-legacy-track-1", requirements: [requirement] })).resolves.toMatchObject({ owns: true, source: "mainnet-rpc" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("maps a non-holder legacy check to 401 at the verifier boundary", async () => {
    const config = { authAllowedChainIds: [43113], ownershipMaxIndexerLagBlocks: 24, ownershipMaxIndexerStalenessMs: 120_000, mainnetRpcUrl: "https://api.avax.network/ext/bc/C/rpc" };
    const mainnetClient = new MainnetBalanceClient({ rpcUrl: config.mainnetRpcUrl, fetchImpl: vi.fn().mockResolvedValue(rpcResult("0x" + "0".padStart(64, "0"))) });
    const verifier = new IndexedOwnershipVerifier({ db: { query: vi.fn() }, config, mainnetClient, denyUnauthorizedWith401: true });
    await expect(verifier.verify({ wallet, requirements: [requirement] })).rejects.toBeInstanceOf(ApiError);
    await expect(verifier.verify({ wallet, requirements: [requirement] })).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
  });
});
