import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const script = await readFile(new URL("../scripts/deploy-release-v2-mainnet.mjs", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

describe("C-Chain deployment safety", () => {
  it("is exposed through the mainnet-only deployment command", () => {
    expect(packageJson.scripts["deploy:release-v2-mainnet"]).toBe("node scripts/deploy-release-v2-mainnet.mjs");
    expect(script).toContain('process.env.DEPLOY_NETWORK !== "mainnet"');
    expect(script).toContain('process.env.CONFIRM_MAINNET_DEPLOY !== "yes"');
    expect(script).toContain("network.chainId !== CHAIN_ID");
    expect(script).toContain("Deployer has no C-Chain AVAX funding");
  });

  it("requires Safe handoff support before any broadcast and excludes legacy contracts", () => {
    expect(script).toContain('artifactMethod(saleArtifact, "transferOwnership(address)"');
    expect(script).toContain("ADMIN_SAFE_ADDRESS");
    expect(script).toContain("VoidProvenanceAnchor");
    expect(script).not.toContain("d1b4367dd9f235f9ee61878019d66e31511e98ee");
    expect(script).not.toContain("MusicMarketplace");
  });

  it("records verification only after role, owner, and anchor checks", () => {
    expect(script).toContain("Safe does not hold DEFAULT_ADMIN_ROLE after handoff");
    expect(script).toContain("Deployer still holds DEFAULT_ADMIN_ROLE");
    expect(script).toContain("Primary-sale owner is not the Safe after handoff");
    expect(script).toContain("Provenance anchor release address mismatch");
    expect(script).toContain('deployed: true');
  });
});
