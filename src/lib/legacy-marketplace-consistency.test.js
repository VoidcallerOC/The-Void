// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LEGACY_COLLECTION_MARKETPLACE as manifest, isLegacyMarketplace, legacyCollectionFor, legacyMarketplaceActive } from "../../config/legacy-collection-marketplace.js";
import { RELEASE_PER_CONTRACT_MANIFESTS } from "../../config/release-network.js";
import { withLegacyCollectionMarketplace } from "../../server/config.js";
import { assertCanonicalMarketplaceTarget, marketplaceConfigForEdition } from "./marketplace.js";
import { isLegacyCollectionCandidate } from "./secondary-listing.js";

const mainnet = RELEASE_PER_CONTRACT_MANIFESTS.mainnet;
const MARKET = "0x00000000000000000000000000000000000a11ce";
const SAFE = "0x1111111111111111111111111111111111111111";
const active = Object.freeze({ ...manifest, deployed: true, marketplaceAddress: MARKET, deploymentBlock: 123, ownerAddress: SAFE });
const v4Base = Object.freeze({ enabled: true, chainId: 43114, address: mainnet.marketplaceAddress, feeBps: "250", currency: "native" });
const genesisEdition = { chainId: 43114, contractAddress: manifest.collections[0].address.toLowerCase(), tokenIds: ["0"] };

describe("deployment gate and candidate scope (manifest)", () => {
  it("is disabled, with no marketplace, block or owner recorded, until a verified deployment is deliberately entered", () => {
    expect(manifest.deployed).toBe(false);
    expect(manifest.marketplaceAddress).toBeNull();
    expect(manifest.deploymentBlock).toBeNull();
    expect(manifest.ownerAddress).toBeNull();
    expect(legacyMarketplaceActive()).toBe(false);
  });

  it("carries exactly the locked scope: Genesis ids 0-3, 500 bps cap, 0% platform fee and no fee recipient", () => {
    expect(manifest.chainId).toBe(43114);
    expect(manifest.platformFeeBps).toBe(0);
    expect(manifest).not.toHaveProperty("feeRecipient");
    expect(manifest.collections).toHaveLength(1);
    expect(manifest.collections[0]).toMatchObject({ address: "0xD1B4367dd9f235f9ee61878019d66E31511E98eE", minTokenId: 0, maxTokenId: 3, maxRoyaltyBps: 500, expectedRoyaltyReceiver: "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a" });
    expect(manifest.collections[0].address.toLowerCase()).not.toBe(mainnet.factoryAddress.toLowerCase());
  });

  it("does not touch the V4 deployment record", () => {
    expect(mainnet.marketplaceAddress).toBe("0x0e77116142844478a55EEd2Ab79de9F93770F8f5");
    expect(mainnet.marketplaceFeeBps).toBe(250);
    expect(mainnet.artistRoyaltyBps).toBe(250);
  });
});

describe("one marketplace address across frontend, purchase path, indexer and readiness policy", () => {
  it("is inert everywhere while undeployed", () => {
    expect(isLegacyCollectionCandidate(genesisEdition)).toBe(false);
    expect(marketplaceConfigForEdition(genesisEdition, v4Base).address).toBe(v4Base.address);
    expect(withLegacyCollectionMarketplace([], { chainId: 43114 })).toHaveLength(0);
  });

  it("agrees on a single address once a deployment is recorded, and the purchase target assertion accepts exactly it", () => {
    const frontend = marketplaceConfigForEdition(genesisEdition, v4Base, active);
    const [indexed, ...others] = withLegacyCollectionMarketplace([], { chainId: 43114, manifest: active });
    expect(others).toHaveLength(0);
    expect(frontend.address).toBe(MARKET);
    expect(indexed.address).toBe(MARKET);
    expect(indexed.startBlock).toBe(123);
    expect(isLegacyMarketplace(MARKET, active)).toBe(true);
    expect(assertCanonicalMarketplaceTarget({ marketplace: MARKET, chainId: 43114, config: frontend })).toBe(MARKET);
    // a Genesis listing can't be bought through the V4 target, and a factory release can't be bought through the legacy one
    expect(() => assertCanonicalMarketplaceTarget({ marketplace: v4Base.address, chainId: 43114, config: frontend })).toThrow(/verified marketplace/);
    const factoryEdition = { chainId: 43114, contractAddress: "0x2222222222222222222222222222222222222222", tokenIds: ["7"] };
    expect(marketplaceConfigForEdition(factoryEdition, v4Base, active).address).toBe(v4Base.address);
  });

  it("scopes the frontend's eligibility to the same ids the contract enforces", () => {
    for (const id of ["0", "1", "2", "3"]) expect(legacyCollectionFor({ chainId: 43114, contractAddress: manifest.collections[0].address, tokenId: id }, active)).not.toBeNull();
    for (const id of ["4", "-1", "01x"]) expect(legacyCollectionFor({ chainId: 43114, contractAddress: manifest.collections[0].address, tokenId: id }, active)).toBeNull();
  });
});

describe("source tripwire: the contract's owner powers and dangerous constructs (review aid, not a proof)", () => {
  const source = readFileSync(new URL("../../contracts/LegacyCollectionMarketplace.sol", import.meta.url), "utf8");
  const code = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations = [...code.matchAll(/function\s+(\w+)\s*\(([^)]*)\)([^{;]*)[{;]/g)].map((match) => ({ name: match[1], header: match[3] }));
  const externals = declarations.filter((item) => /\b(external|public)\b/.test(item.header)).map((item) => item.name).sort();

  it("exposes exactly the reviewed external surface (a new public function must be reviewed and added here)", () => {
    expect(externals).toEqual(["acceptOwnership", "allowCollection", "buy", "cancelListing", "createListingWithMinProceeds", "disableCollection", "expireListing", "getCollection", "getListing", "isSupported", "listingStatus", "previewSettlement", "setMinSellerProceeds", "setPaused", "transferOwnership"]);
  });

  it("has exactly one way to create a listing, with the floor mandatory and the V4-shaped createListing absent", () => {
    expect(code).not.toMatch(/function\s+createListing\s*\(/);
    expect((code.match(/\blistings\[\w+\]\s*=\s*Listing\(/g) || []).length).toBe(1); // the only place a listing is written
    expect((code.match(/\b_createListing\(/g) || []).length).toBe(2); // the definition and the single external caller
    expect(code).toMatch(/if \(minPerUnit == 0\) revert MinProceedsRequired\(\);/);
    expect((code.match(/_requireAttainable\(/g) || []).length).toBe(3); // definition + create + setMinSellerProceeds
    expect(code).not.toMatch(/minSellerProceedsPerUnit\[\w+\]\s*=\s*0\b/);
  });

  it("gives the owner only collection management, pause and ownership transfer", () => {
    const ownerOnly = declarations.filter((item) => /\bonlyOwner\b/.test(item.header)).map((item) => item.name).sort();
    expect(ownerOnly).toEqual(["allowCollection", "disableCollection", "setPaused", "transferOwnership"]);
  });

  it("has no custody, upgrade, arbitrary-call or ambient-balance escape hatches", () => {
    for (const forbidden of [/delegatecall/, /selfdestruct/, /tx\.origin/, /\breceive\s*\(/, /\bfallback\s*\(/, /\.transfer\s*\(/, /\.send\s*\(/, /\binitialize\b/, /\bupgrade/i, /address\(this\)\.balance/, /\bpayable\(owner\)/]) {
      expect(code).not.toMatch(forbidden);
    }
    expect((code.match(/\.call\{value:/g) || []).length).toBe(1); // the single payout primitive, _pay
    expect((code.match(/\bassembly\b/g) || []).length).toBe(1); // the bounded royaltyInfo read
    expect(code).toMatch(/uint256 private constant ROYALTY_READ_GAS = 100_000;/);
    expect(code).toMatch(/uint16 public constant ROYALTY_CEILING_BPS = 1_000;/);
    // Genesis policy: the platform fee is a compile-time zero and nothing in the contract can receive one.
    expect(code).toMatch(/uint256 public constant platformFeeBps = 0;/);
    expect(code).not.toMatch(/feeRecipient/);
    expect(code).not.toMatch(/platformFeeBps_/);
    expect(code).toMatch(/platformFee = 0;/);
    expect(code).toMatch(/constructor\(address owner_\)/);
  });

  it("only the buy path pays out, in a fixed order after the seller-floor check and the token transfer", () => {
    const settle = code.slice(code.indexOf("function _settle("), code.indexOf("// ---", code.indexOf("function _settle(")));
    const order = ["_requireMinimumProceeds(", "_deliver(", "_pay(royaltyReceiver", "_pay(seller"].map((needle) => settle.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect((code.match(/_pay\(/g) || []).length).toBe(3); // royalty + seller in _settle, plus the definition: no platform payout exists
    expect((code.match(/\.safeTransferFrom\(/g) || []).length).toBe(1); // the only token movement, inside _deliver
    const deliver = code.slice(code.indexOf("function _deliver("), code.indexOf("// ---", code.indexOf("function _deliver(")));
    expect(deliver).toMatch(/revert TokensNotDelivered\(\)/); // ... and it verifies the buyer's balance rose
    expect(code).toMatch(/if \(listing\.seller == msg\.sender\) revert SelfPurchase\(\);/);
    expect(code).toMatch(/if \(listing\.seller == address\(0\)\) revert UnknownListing\(\);/);
  });
});
