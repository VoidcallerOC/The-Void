import { readFileSync } from "node:fs";
import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { loadIndexerConfig, loadServerConfig } from "./config.js";
import { loadGenesisClaimConfig } from "./genesis-claim.js";

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
    return {
      name,
      region: block.match(/region: (\S+)/)?.[1],
      autoDeploy: block.match(/autoDeployTrigger: "?(\w+)"?/)?.[1],
      dockerCommand: block.match(/dockerCommand: (.+)/)?.[1]?.trim(),
      env,
    };
  });
}

describe("mainnet runtime configuration", () => {
  const [api, indexer] = services(blueprint);

  it("defines separate C-Chain services that never deploy on merge and never reference Fuji", () => {
    expect([api.name, indexer.name]).toEqual(["the-void-api-mainnet", "the-void-indexer-mainnet"]);
    for (const service of [api, indexer]) {
      expect(service.autoDeploy).toBe("off");
      expect(service.region).toBe("ohio");
      expect(service.env).toMatchObject({ RELEASE_NETWORK: "mainnet", INDEXER_CHAIN_ID: "43114", MARKETPLACE_CHAIN_ID: "43114", INDEXER_RPC_URL: "https://api.avax.network/ext/bc/C/rpc" });
      expect(service.env.DATABASE_URL).toBeNull();
    }
    expect(blueprint).not.toMatch(/43113|avax-test|fuji\.|-fuji/);
  });

  it("ships the Genesis claim on the production C-Chain schedule, disabled until activation, with secrets out of the file", () => {
    expect(api.env).toMatchObject({
      GENESIS_CLAIM_ENABLED: "false", GENESIS_RPC_URL: "https://api.avax.network/ext/bc/C/rpc", GENESIS_DESTINATION_RPC_URL: "https://api.avax.network/ext/bc/C/rpc",
      GENESIS_CLAIM_WINDOW_SECONDS: "86400", GENESIS_PUBLIC_WINDOW_SECONDS: "604800", GENESIS_PUBLIC_PRICE_WEI: "250000000000000000",
    });
    // 0 means uncapped (open edition); a finite free-claim cap is never configured.
    expect(api.env).toMatchObject({ GENESIS_CLAIM_ALLOCATION: "0", GENESIS_PUBLIC_MINT_ALLOCATION: "0" });
    expect(blueprint).not.toMatch(/0x[0-9a-fA-F]{64}/);
    for (const key of ["DATABASE_URL", "DATABASE_SSL_CA", "PINATA_JWT", "MEDIA_AUDIT_HASH_SECRET", "X_API_SECRET", "PUBLIC_APP_URL", "INDEXER_CONTRACTS_JSON", "GENESIS_CLAIM_SIGNER_PRIVATE_KEY", "GENESIS_CLAIM_CONTRACT", "GENESIS_CLAIM_RELEASE_CONTRACT", "GENESIS_CLAIM_PRIMARY_SALE", "GENESIS_CLAIM_TOKEN_ID", "GENESIS_CLAIM_START"]) {
      expect(key in api.env ? api.env[key] : indexer.env[key], key).toBeNull();
    }
    expect(api.env.DATABASE_SSL).toBe("true");
    expect(indexer.env.DATABASE_SSL).toBe("true");
    expect(indexer.env.DATABASE_SSL_CA).toBeNull();
    // API and worker both declare INDEXER_CONTRACTS_JSON (Fuji pattern): readiness scopes to it.
    expect(api.env.INDEXER_CONTRACTS_JSON).toBeNull();
    expect(indexer.env.INDEXER_CONTRACTS_JSON).toBeNull();
    expect(api.env.GENESIS_CLAIM_ENABLED).toBe("false");

  });

  it("loads the Genesis claim as a C-Chain production claim once its values are entered and it is enabled", () => {
    expect(loadGenesisClaimConfig(api.env)).toBeNull();
    const entered = {
      ...api.env, GENESIS_CLAIM_ENABLED: "true", GENESIS_CLAIM_CONTRACT: "0x00000000000000000000000000000000000000c1", GENESIS_CLAIM_RELEASE_CONTRACT: "0x00000000000000000000000000000000000000c2",
      GENESIS_CLAIM_PRIMARY_SALE: "0x00000000000000000000000000000000000000c3", GENESIS_CLAIM_TOKEN_ID: "7", GENESIS_CLAIM_START: "1900000000", GENESIS_CLAIM_SIGNER_PRIVATE_KEY: `0x${"5a".repeat(32)}`, GENESIS_CLAIM_SIGNER_ADDRESS: new Wallet(`0x${"5a".repeat(32)}`).address,
    };
    expect(loadGenesisClaimConfig(entered)).toMatchObject({ destinationChainId: 43114, claimWindow: 86_400n, publicWindow: 604_800n, publicPriceWei: 250_000_000_000_000_000n, allocation: 0n, publicAllocation: 0n });
    expect(() => loadGenesisClaimConfig({ ...entered, GENESIS_CLAIM_WINDOW_SECONDS: "300" })).toThrow(/24-hour/);
  });

  it("loads as a production C-Chain API and indexer configuration", () => {
    const origin = "https://mainnet.the-void.example";
    const apiEnv = { ...api.env, DATABASE_URL: "postgres://user:pass@db.example:5432/postgres", PUBLIC_APP_URL: origin, AUTH_DOMAIN: "mainnet.the-void.example", AUTH_URI: `${origin}/reliquary`, API_ALLOWED_ORIGINS: origin };
    expect(loadServerConfig(apiEnv)).toMatchObject({ appEnvironment: "production", authAllowedChainIds: [43114] });
    const contracts = JSON.stringify([{ address: "0x0e77116142844478a55EEd2Ab79de9F93770F8f5", contractType: "MARKETPLACE", startBlock: 1, platformFeeBps: 250 }]);
    expect(loadIndexerConfig({ ...indexer.env, INDEXER_CONTRACTS_JSON: contracts })).toMatchObject({ chainId: 43114 });
    // Worker blueprint has no PUBLIC_APP_URL / AUTH_*; indexer/migrate must still load DB config.
    expect(indexer.dockerCommand).toBe("npm run start:indexer");
    expect(indexer.env.PUBLIC_APP_URL).toBeUndefined();
    expect(loadServerConfig({ ...indexer.env, DATABASE_URL: "postgres://user:pass@db.example:5432/postgres" }, { requireWalletAuth: false })).toMatchObject({
      appEnvironment: "production",
      authAllowedChainIds: [43114],
    });
    expect(() => loadServerConfig({ ...indexer.env, DATABASE_URL: "postgres://user:pass@db.example:5432/postgres" })).toThrow(/HTTPS PUBLIC_APP_URL/);
  });

  it("sends security headers on site responses and no wildcard CORS, leaving API CORS to the API", () => {
    for (const [config, origin] of [[fujiVercel, "https://the-void-alpha.vercel.app"], [mainnetVercel, "https://www.thevoidstudio.xyz"]]) {
      const site = config.headers[0];
      // Every path except the API and the two asset paths proxied to the API, which keep the API's allowlisted CORS.
      expect(site.source).toBe("/((?!api/|assets/marketplace-heroes/|assets/artist-portfolio/).*)");
      const value = (key) => site.headers.find((header) => header.key === key)?.value;
      expect(value("X-Content-Type-Options")).toBe("nosniff");
      expect(value("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
      expect(value("Permissions-Policy")).toMatch(/camera=\(\)/);
      expect(value("X-Frame-Options")).toBe("DENY");
      expect(value("Content-Security-Policy")).toBe("frame-ancestors 'none'");
      // Replaces Vercel's default `*` on static responses with the site's own origin.
      expect(value("Access-Control-Allow-Origin")).toBe(origin);
      const pattern = new RegExp(`^${site.source.replace(/^\//, "\\/")}$`);
      for (const path of ["/", "/index.html", "/assets/main-abc.js", "/release/forgive-forget"]) expect(pattern.test(path)).toBe(true);
      for (const path of ["/api/health/ready", "/assets/marketplace-heroes/a.webp", "/assets/artist-portfolio/a.webp"]) expect(pattern.test(path)).toBe(false);
      expect(JSON.stringify(config.headers)).not.toMatch(/"Access-Control-Allow-Origin","value":"\*"/);
    }
  });

  it("serves the mainnet web build from its own Vercel project with only the API host changed", () => {
    // Only the API host and the site's own origin (Access-Control-Allow-Origin on site responses) differ.
    const swap = (value) => JSON.parse(JSON.stringify(value).replaceAll("the-void-api-mainnet.onrender.com", "the-void-api-fuji.onrender.com").replaceAll("https://www.thevoidstudio.xyz", "https://the-void-alpha.vercel.app"));
    const { installCommand, buildCommand, outputDirectory, ...routing } = mainnetVercel;
    // Identical routing, except that the Fuji Rabby test page exists only on the Fuji project.
    const withoutFujiTest = JSON.parse(JSON.stringify(fujiVercel));
    withoutFujiTest.rewrites = withoutFujiTest.rewrites.filter((rule) => rule.source !== "/fuji-rabby-test");
    for (const rule of withoutFujiTest.headers) if (rule.source === "/(owner-deploy|fuji-rabby-test)(.html)?") rule.source = "/owner-deploy(.html)?";
    expect(swap(routing)).toEqual(withoutFujiTest);
    // Vercel caps buildCommand at 256 characters, so the command runs the root build:mainnet script, which bakes the
    // network, the marketplace, the fee and the artwork gateway. The baked values are checked on the resolved build.
    expect(buildCommand).toBe("cd ../.. && npm run build:mainnet");
    expect(buildCommand.length).toBeLessThanOrEqual(256);
    const build = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts["build:mainnet"];
    expect(build).toContain("VITE_RELEASE_NETWORK=mainnet");
    expect(build).toContain("VITE_MARKETPLACE_CHAIN_ID=43114");
    // The canonical marketplace is the recorded unified marketplace; the build target, the manifest and the buy-target check agree.
    expect(build).toContain("VITE_MARKETPLACE_ADDRESS=0x0F5930113Ec750d867741E05F302053472115eb2");
    const unified = JSON.parse(readFileSync(new URL("../config/unified-marketplace.json", import.meta.url), "utf8"));
    expect(unified.marketplaceAddress).toBe("0x0F5930113Ec750d867741E05F302053472115eb2");
    // The earlier unified marketplace is retained (its listings stay buyable), never the build's listing target.
    expect(unified.retainedMarketplaces.map((entry) => entry.marketplaceAddress)).toEqual(["0x75964C44cA586b13e98e7c30E74d2B4114f65b06"]);
    expect(build).not.toContain("0x75964C44cA586b13e98e7c30E74d2B4114f65b06");
    expect(build).toContain("VITE_MARKETPLACE_FEE_BPS=250");
    // Artwork images come from the account's dedicated Pinata gateway (src/lib/artwork.js); the Fuji build stays on the public gateway.
    expect(build).toContain("VITE_IPFS_GATEWAY=https://fuchsia-labour-butterfly-445.mypinata.cloud/ipfs/");
    expect(build).toContain("vite build --outDir deploy/vercel-mainnet/dist --emptyOutDir");
    expect(JSON.stringify(fujiVercel)).not.toContain("VITE_IPFS_GATEWAY");
    expect(JSON.stringify(mainnetVercel)).not.toMatch(/fuji|43113|avax-test/);
    expect({ installCommand, outputDirectory }).toEqual({ installCommand: "cd ../.. && npm ci", outputDirectory: "dist" });
  });
});
