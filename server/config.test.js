import { describe, expect, it } from "vitest";
import { ConfigurationError, loadServerConfig } from "./config.js";
import { ContractOwnerVerificationService } from "./contract-owner-verification.js";

const MAINNET_RPC = "https://api.avax.network/ext/bc/C/rpc";
const base = { DATABASE_URL: "postgres://example" };

describe("loadServerConfig MAINNET_RPC_URL", () => {
  it("reads MAINNET_RPC_URL from the environment into config.mainnetRpcUrl", () => {
    const config = loadServerConfig({ ...base, MAINNET_RPC_URL: `  ${MAINNET_RPC}  ` });
    expect(config.mainnetRpcUrl).toBe(MAINNET_RPC);
  });

  it("reads MAINNET_RPC_URL under production settings", () => {
    const config = loadServerConfig({ ...base, NODE_ENV: "production", PUBLIC_APP_URL: "https://the-void-alpha.vercel.app", MAINNET_RPC_URL: MAINNET_RPC });
    expect(config.mainnetRpcUrl).toBe(MAINNET_RPC);
  });

  it("leaves mainnetRpcUrl empty when MAINNET_RPC_URL is unset or blank", () => {
    expect(loadServerConfig(base).mainnetRpcUrl).toBe("");
    expect(loadServerConfig({ ...base, MAINNET_RPC_URL: "   " }).mainnetRpcUrl).toBe("");
  });

  it("rejects a MAINNET_RPC_URL that is not an absolute HTTP(S) URL", () => {
    expect(() => loadServerConfig({ ...base, MAINNET_RPC_URL: "not a url" })).toThrow(ConfigurationError);
    expect(() => loadServerConfig({ ...base, MAINNET_RPC_URL: "wss://api.avax.network/ext/bc/C/ws" })).toThrow(/MAINNET_RPC_URL/);
    expect(() => loadServerConfig({ ...base, MAINNET_RPC_URL: "https://user:pass@rpc.example/ext" })).toThrow(/MAINNET_RPC_URL/);
  });

  it("requires HTTPS for MAINNET_RPC_URL in production", () => {
    expect(() => loadServerConfig({ ...base, NODE_ENV: "production", PUBLIC_APP_URL: "https://the-void-alpha.vercel.app", MAINNET_RPC_URL: "http://rpc.example/ext/bc/C/rpc" })).toThrow(/Production MAINNET_RPC_URL must use HTTPS/);
  });

  it("wires the env value through to the contract owner verification reader", () => {
    const config = loadServerConfig({ ...base, MAINNET_RPC_URL: MAINNET_RPC });
    const service = new ContractOwnerVerificationService({ db: { query: async () => ({ rows: [] }) }, config });
    expect(service.ownerReader.rpcUrl).toBe(MAINNET_RPC);
  });
});

describe("loadServerConfig production wallet auth vs indexer/migrate", () => {
  // Regression: mainnet indexer blueprint omits PUBLIC_APP_URL / AUTH_*. With the
  // development default http://localhost:5173, requireWalletAuth (API) fails the HTTPS
  // gate even when RELEASE_NETWORK=mainnet and AUTH_ALLOWED_CHAIN_IDS=43114.
  const mainnetIndexerEnv = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://user:pass@db.example:5432/postgres",
    RELEASE_NETWORK: "mainnet",
    AUTH_ALLOWED_CHAIN_IDS: "43114",
  };

  it("fails closed for API boot when PUBLIC_APP_URL defaults to http localhost under mainnet production", () => {
    expect(() => loadServerConfig(mainnetIndexerEnv)).toThrow(/HTTPS PUBLIC_APP_URL and AUTH_URI/);
    expect(() => loadServerConfig(mainnetIndexerEnv)).toThrow(/localhost:5173/);
  });

  it("loads DB config for indexer/migrate without wallet-auth URLs when requireWalletAuth is false", () => {
    expect(loadServerConfig(mainnetIndexerEnv, { requireWalletAuth: false })).toMatchObject({
      appEnvironment: "production",
      authAllowedChainIds: [43114],
      publicAppUrl: "http://localhost:5173",
    });
  });

  it("still requires HTTPS PUBLIC_APP_URL for production API wallet auth", () => {
    const origin = "https://www.thevoidstudio.xyz";
    expect(loadServerConfig({
      ...mainnetIndexerEnv,
      PUBLIC_APP_URL: origin,
      AUTH_DOMAIN: "www.thevoidstudio.xyz",
      AUTH_URI: origin,
    })).toMatchObject({ authAllowedChainIds: [43114], authDomain: "www.thevoidstudio.xyz" });
    expect(() => loadServerConfig({
      ...mainnetIndexerEnv,
      PUBLIC_APP_URL: "http://www.thevoidstudio.xyz",
      AUTH_DOMAIN: "www.thevoidstudio.xyz",
      AUTH_URI: "http://www.thevoidstudio.xyz",
    })).toThrow(/HTTPS PUBLIC_APP_URL and AUTH_URI/);
  });
});
