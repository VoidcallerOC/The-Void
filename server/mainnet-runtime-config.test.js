import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadIndexerConfig, loadServerConfig } from "./config.js";

// The mainnet runtime (deploy/mainnet/render.mainnet.yaml, deploy/vercel-mainnet/vercel.json) is
// isolated from Fuji: its own services, database and web project, C-Chain only, claims disabled.
const blueprint = readFileSync(new URL("../deploy/mainnet/render.mainnet.yaml", import.meta.url), "utf8");
const fujiVercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const mainnetVercel = JSON.parse(readFileSync(new URL("../deploy/vercel-mainnet/vercel.json", import.meta.url), "utf8"));

function services(text) {
  return text.split(/\n {2}- type: /).slice(1).map((block) => {
    const name = block.match(/name: (\S+)/)[1];
    const env = {};
    for (const match of block.matchAll(/- key: (\S+)\n\s+(value|sync): ("?)([^\n"]*)\3/g)) env[match[1]] = match[2] === "sync" ? null : match[4];
    return { name, autoDeploy: block.match(/autoDeployTrigger: "?(\w+)"?/)?.[1], env };
  });
}

describe("mainnet runtime configuration", () => {
  const [api, indexer] = services(blueprint);

  it("defines separate C-Chain services that never deploy on merge and never reference Fuji", () => {
    expect([api.name, indexer.name]).toEqual(["the-void-api-mainnet", "the-void-indexer-mainnet"]);
    for (const service of [api, indexer]) {
      expect(service.autoDeploy).toBe("off");
      expect(service.env).toMatchObject({ RELEASE_NETWORK: "mainnet", INDEXER_CHAIN_ID: "43114", MARKETPLACE_CHAIN_ID: "43114", INDEXER_RPC_URL: "https://api.avax.network/ext/bc/C/rpc" });
      expect(service.env.DATABASE_URL).toBeNull();
    }
    expect(blueprint).not.toMatch(/43113|avax-test|fuji\.|-fuji/);
  });

  it("keeps Genesis claims disabled and secrets out of the file", () => {
    expect(api.env.GENESIS_CLAIM_ENABLED).toBe("false");
    expect(blueprint).not.toMatch(/GENESIS_CLAIM_SIGNER_PRIVATE_KEY|PRIVATE_KEY/);
    for (const key of ["DATABASE_URL", "PINATA_JWT", "MEDIA_AUDIT_HASH_SECRET", "X_API_SECRET", "PUBLIC_APP_URL", "INDEXER_CONTRACTS_JSON"]) {
      expect(key in api.env ? api.env[key] : indexer.env[key], key).toBeNull();
    }
  });

  it("loads as a production C-Chain API and indexer configuration", () => {
    const origin = "https://mainnet.the-void.example";
    const apiEnv = { ...api.env, DATABASE_URL: "postgres://user:pass@db.example:5432/postgres", PUBLIC_APP_URL: origin, AUTH_DOMAIN: "mainnet.the-void.example", AUTH_URI: `${origin}/reliquary`, API_ALLOWED_ORIGINS: origin };
    expect(loadServerConfig(apiEnv)).toMatchObject({ appEnvironment: "production", authAllowedChainIds: [43114] });
    const contracts = JSON.stringify([{ address: "0x0e77116142844478a55EEd2Ab79de9F93770F8f5", contractType: "MARKETPLACE", startBlock: 1, platformFeeBps: 250 }]);
    expect(loadIndexerConfig({ ...indexer.env, INDEXER_CONTRACTS_JSON: contracts })).toMatchObject({ chainId: 43114 });
  });

  it("serves the mainnet web build from its own Vercel project with only the API host changed", () => {
    const swap = (value) => JSON.parse(JSON.stringify(value).replaceAll("the-void-api-mainnet.onrender.com", "the-void-api-fuji.onrender.com"));
    const { installCommand, buildCommand, outputDirectory, ...routing } = mainnetVercel;
    expect(swap(routing)).toEqual(fujiVercel);
    expect(buildCommand).toContain("VITE_RELEASE_NETWORK=mainnet");
    expect(JSON.stringify(mainnetVercel)).not.toMatch(/fuji/);
    expect({ installCommand, outputDirectory }).toEqual({ installCommand: "cd ../.. && npm ci", outputDirectory: "dist" });
  });
});
