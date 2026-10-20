import { describe, expect, it } from "vitest";
import { LEGACY_COLLECTION_MARKETPLACE } from "../config/legacy-collection-marketplace.js";
import { RELEASE_PER_CONTRACT_DEPLOYMENTS } from "../config/release-network.js";
import { marketplaceConfigForEdition, MARKETPLACE_CONFIG } from "../src/lib/marketplace.js";
import { withLegacyCollectionMarketplace } from "./config.js";

const MARKET = "0x00000000000000000000000000000000000a11ce";
const active = { ...LEGACY_COLLECTION_MARKETPLACE, deployed: true, marketplaceAddress: MARKET, deploymentBlock: 12345 };
const v4 = RELEASE_PER_CONTRACT_DEPLOYMENTS.find((item) => item.chainId === 43114);

describe("legacy-collection marketplace indexer registration", () => {
  it("adds nothing while the marketplace is not deployed", () => {
    const contracts = Object.freeze([]);
    expect(withLegacyCollectionMarketplace(contracts, { chainId: 43114 })).toBe(contracts);
  });

  it("registers exactly one MARKETPLACE contract at the recorded address and block, only on its chain", () => {
    const [entry, ...rest] = withLegacyCollectionMarketplace([], { chainId: 43114, manifest: active });
    expect(rest).toHaveLength(0);
    expect(entry).toMatchObject({ chainId: 43114, address: MARKET, contractType: "MARKETPLACE", startBlock: 12345, platformFeeBps: 250, reconcileListings: true });
    expect(withLegacyCollectionMarketplace([], { chainId: 43113, manifest: active })).toHaveLength(0);
    expect(withLegacyCollectionMarketplace([entry], { chainId: 43114, manifest: active })).toHaveLength(1);
  });

  it("keeps the V4 factory marketplace indexed beside it and agrees with the frontend's marketplace selection", () => {
    const base = { ...MARKETPLACE_CONFIG, enabled: true, chainId: 43114, address: v4.marketplaceAddress };
    const indexed = withLegacyCollectionMarketplace([{ chainId: 43114, address: v4.marketplaceAddress.toLowerCase(), contractType: "MARKETPLACE" }], { chainId: 43114, manifest: active });
    const addresses = indexed.map((item) => item.address.toLowerCase());
    expect(addresses).toContain(v4.marketplaceAddress.toLowerCase());
    expect(addresses).toContain(MARKET);
    const genesisEdition = { chainId: 43114, contractAddress: LEGACY_COLLECTION_MARKETPLACE.collections[0].address, tokenIds: ["0"] };
    expect(marketplaceConfigForEdition(genesisEdition, base, active).address.toLowerCase()).toBe(MARKET);
    expect(addresses).toContain(marketplaceConfigForEdition(genesisEdition, base, active).address.toLowerCase());
  });
});
