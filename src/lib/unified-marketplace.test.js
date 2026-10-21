import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import { UNIFIED_MARKETPLACE, unifiedMarketplaceActive, unifiedAssetClass, isGenesisAsset, unifiedPlatformFeeBps } from "../../config/unified-marketplace.js";
import { marketplaceConfigForEdition } from "./marketplace.js";
import { readUnifiedListingContext } from "./secondary-listing.js";
import { withUnifiedMarketplace } from "../../server/config.js";
import { decodeMarketplaceLog } from "../../server/marketplace-events.js";

// Hypothetical recorded deployment; the UNIFIED/CORRECTED addresses are placeholders. Nothing here is deployed.
const UNIFIED = "0x000000000000000000000000000000000000fa11";
const CORRECTED_FACTORY = "0x00000000000000000000000000000000000c0ffe";
const PRODUCTION_FACTORY = "0x262B774cf9a1949170B58E2d57F6189980FE757b";
const GENESIS = "0xD1B4367dd9f235f9ee61878019d66E31511E98eE";
const CREATOR = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";
const SELLER = "0x00000000000000000000000000000000000b0b01";
const active = Object.freeze({ ...UNIFIED_MARKETPLACE, deployed: true, marketplaceAddress: UNIFIED, deploymentBlock: 99000000, releaseFactoryAddress: CORRECTED_FACTORY });
const base = Object.freeze({ address: UNIFIED, chainId: 43114, enabled: true });

describe("unified marketplace manifest", () => {
  it("is active at the verified mainnet deployment", () => {
    expect(UNIFIED_MARKETPLACE).toMatchObject({ deployed: true, chainId: 43114, marketplaceAddress: "0x75964C44cA586b13e98e7c30E74d2B4114f65b06", deploymentBlock: 98161532, releaseFactoryAddress: "0xE744D58fA8138042f5f00a28d39f89081539C19B", feeRecipient: "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4", record: "deployments/release-per-contract-mainnet-0xE744D58fA8138042f5f00a28d39f89081539C19B.json" });
    expect(unifiedMarketplaceActive()).toBe(true);
    expect(UNIFIED_MARKETPLACE.genesis).toMatchObject({ address: GENESIS, platformFeeBps: 0, royaltyBps: 500, royaltyReceiver: CREATOR, minTokenId: 0, maxTokenId: 3 });
    expect(UNIFIED_MARKETPLACE.legacyReleaseFactoryAddress).toBe(PRODUCTION_FACTORY);
  });

  it("classifies Genesis by address and id range, factory releases by recorded factory, nothing else", () => {
    expect(unifiedAssetClass({ chainId: 43114, contractAddress: GENESIS, tokenId: "3" }, active)).toBe("GENESIS");
    expect(unifiedAssetClass({ chainId: 43114, contractAddress: GENESIS, tokenId: "4" }, active)).toBeNull();
    expect(unifiedAssetClass({ chainId: 43114, contractAddress: GENESIS, tokenId: "0", factoryAddress: CORRECTED_FACTORY }, active)).toBe("GENESIS");
    expect(unifiedAssetClass({ chainId: 43114, contractAddress: "0x0000000000000000000000000000000000000123", tokenId: "1", factoryAddress: CORRECTED_FACTORY }, active)).toBe("FACTORY_RELEASE");
    expect(unifiedAssetClass({ chainId: 43114, contractAddress: "0x0000000000000000000000000000000000000123", tokenId: "1", factoryAddress: PRODUCTION_FACTORY }, active)).toBe("FACTORY_RELEASE");
    expect(unifiedAssetClass({ chainId: 43114, contractAddress: "0x0000000000000000000000000000000000000123", tokenId: "1", factoryAddress: "0x0000000000000000000000000000000000000999" }, active)).toBeNull();
    expect(unifiedAssetClass({ chainId: 43113, contractAddress: GENESIS, tokenId: "0" }, active)).toBeNull();
    expect(isGenesisAsset(GENESIS, "x")).toBe(false);
    expect(unifiedPlatformFeeBps(GENESIS.toLowerCase(), active)).toBe(0);
    expect(unifiedPlatformFeeBps("0x0000000000000000000000000000000000000123", active)).toBe(250);
  });
});

describe("routing: one canonical marketplace address", () => {
  it("routes Genesis and both factories' releases to the unified address and disables unsupported assets", () => {
    const genesis = marketplaceConfigForEdition({ chainId: 43114, contractAddress: GENESIS, tokenIds: ["1"] }, base, undefined, active);
    expect(genesis).toMatchObject({ address: UNIFIED, assetClass: "GENESIS", enabled: true });
    const corrected = marketplaceConfigForEdition({ chainId: 43114, contractAddress: "0x0000000000000000000000000000000000000123", tokenIds: ["7"], factoryAddress: CORRECTED_FACTORY }, base, undefined, active);
    expect(corrected).toMatchObject({ address: UNIFIED, assetClass: "FACTORY_RELEASE" });
    const production = marketplaceConfigForEdition({ chainId: 43114, contractAddress: "0x0000000000000000000000000000000000000124", tokenIds: ["7"], factoryAddress: PRODUCTION_FACTORY }, base, undefined, active);
    expect(production.address).toBe(UNIFIED);
    const stranger = marketplaceConfigForEdition({ chainId: 43114, contractAddress: "0x0000000000000000000000000000000000000125", tokenIds: ["7"] }, base, undefined, active);
    expect(stranger.enabled).toBe(false);
  });

  it("is inert while the manifest is not deployed", () => {
    const edition = { chainId: 43114, contractAddress: GENESIS, tokenIds: ["1"] };
    expect(marketplaceConfigForEdition(edition, base, undefined, { ...active, deployed: false }).assetClass).toBeUndefined();
  });
});

const view = new Interface([
  "function deploymentChainId() view returns (uint256)",
  "function feeRecipient() view returns (address)",
  "function releaseFactory() view returns (address)",
  "function genesisCollection() view returns (address)",
  "function previewSettlement(address,uint256,uint256) view returns (uint8,uint256,address,uint256,uint256)",
  "function operatorFilterRegistry() view returns (address)",
  "function balanceOf(address,uint256) view returns (uint256)",
  "function isApprovedForAll(address,address) view returns (bool)",
]);

function provider({ preview, filter = "0x0000000000000000000000000000000000000000", feeRecipient = active.feeRecipient }) {
  return {
    async request({ method, params }) {
      if (method === "eth_chainId") return "0xa86a";
      const data = params[0].data;
      const fn = view.parseTransaction({ data }).name;
      const out = { deploymentChainId: [43114], feeRecipient: [feeRecipient], releaseFactory: [CORRECTED_FACTORY], genesisCollection: [GENESIS], previewSettlement: preview, operatorFilterRegistry: [filter], balanceOf: [2], isApprovedForAll: [true] }[fn];
      if (out === "revert") throw new Error("execution reverted");
      return view.encodeFunctionResult(fn, out);
    },
  };
}

describe("listing preflight reads economics from the contract", () => {
  const args = { marketplaceAddress: UNIFIED, marketplaceChainId: 43114, tokenContractAddress: GENESIS, tokenId: "0", seller: SELLER };

  it("accepts Genesis at 0 / 5 / 95", async () => {
    const ctx = await readUnifiedListingContext({ provider: provider({ preview: [2, 0, CREATOR, 5n * 10n ** 16n, 95n * 10n ** 16n] }), ...args }, active);
    expect(ctx).toMatchObject({ assetClass: "GENESIS", marketplaceFeeBps: "0", royaltyBps: "500", royaltyReceiver: CREATOR, factoryAddress: null, balance: "2", approved: true });
  });

  it("accepts a factory release at 2.5 / 2.5 / 95", async () => {
    const ctx = await readUnifiedListingContext({ provider: provider({ preview: [1, 25n * 10n ** 15n, SELLER, 25n * 10n ** 15n, 95n * 10n ** 16n] }), ...args, tokenContractAddress: "0x0000000000000000000000000000000000000123" }, active);
    expect(ctx).toMatchObject({ assetClass: "FACTORY_RELEASE", marketplaceFeeBps: "250", royaltyBps: "250" });
  });

  it("refuses an unsupported asset, a policy mismatch, a changed receiver or a mismatched deployment", async () => {
    await expect(readUnifiedListingContext({ provider: provider({ preview: "revert" }), ...args }, active)).rejects.toMatchObject({ code: "UNSUPPORTED_RELEASE" });
    await expect(readUnifiedListingContext({ provider: provider({ preview: [2, 25n * 10n ** 15n, CREATOR, 5n * 10n ** 16n, 0] }), ...args }, active)).rejects.toMatchObject({ code: "INVALID_ECONOMICS" });
    await expect(readUnifiedListingContext({ provider: provider({ preview: [2, 0, SELLER, 5n * 10n ** 16n, 0] }), ...args }, active)).rejects.toMatchObject({ code: "UNSUPPORTED_RELEASE" });
    await expect(readUnifiedListingContext({ provider: provider({ preview: [2, 0, CREATOR, 5n * 10n ** 16n, 0], feeRecipient: SELLER }), ...args }, active)).rejects.toMatchObject({ code: "MARKETPLACE_UNAVAILABLE" });
    await expect(readUnifiedListingContext({ provider: provider({ preview: [2, 0, CREATOR, 5n * 10n ** 16n, 0] }), ...args, marketplaceAddress: SELLER }, active)).rejects.toMatchObject({ code: "MARKETPLACE_UNAVAILABLE" });
  });
});

describe("indexer", () => {
  it("adds the unified marketplace once, with a per-asset fee policy that replaces a single-bps entry", () => {
    const address = UNIFIED.toLowerCase();
    expect(withUnifiedMarketplace([], { chainId: 43113 })).toEqual([]);
    expect(withUnifiedMarketplace([], { chainId: 43114, manifest: { ...active, deployed: false } })).toEqual([]);
    const result = withUnifiedMarketplace([{ chainId: 43114, address, contractType: "MARKETPLACE", platformFeeBps: 250 }], { chainId: 43114, manifest: active });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ address, contractType: "MARKETPLACE", feePolicy: "unified", platformFeeBps: null, startBlock: 99000000 });
    expect(withUnifiedMarketplace([], { chainId: 43113, manifest: active })).toEqual([]);
  });

  const abi = new Interface([
    "event ListingSold(uint256 indexed listingId, address indexed buyer, address indexed seller, address tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint256 platformFee, uint256 royalty)",
    "event SaleSettled(uint256 indexed listingId, uint8 indexed assetClass, address royaltyReceiver, uint256 sellerProceeds)",
  ]);
  const ref = { address: UNIFIED, chainId: 43114, blockNumber: 1, logIndex: 0, transactionHash: `0x${"1".repeat(64)}`, blockHash: `0x${"2".repeat(64)}`, blockTimestamp: new Date(0) };
  const fee = (token) => unifiedPlatformFeeBps(token, active);
  const sold = (token, platformFee, royalty) => ({ ...ref, ...abi.encodeEventLog("ListingSold", [1, SELLER, SELLER, token, 0, 1, 10n ** 18n, platformFee, royalty]) });

  it("validates the platform fee per asset class", () => {
    expect(decodeMarketplaceLog(sold(GENESIS, 0, 5n * 10n ** 16n), { chainId: 43114, expectedAddress: UNIFIED, platformFeeBps: fee })).toMatchObject({ platformFeeWei: "0", royaltyWei: "50000000000000000" });
    expect(() => decodeMarketplaceLog(sold(GENESIS, 25n * 10n ** 15n, 5n * 10n ** 16n), { chainId: 43114, expectedAddress: UNIFIED, platformFeeBps: fee })).toThrow(/platform fee/);
    const release = "0x0000000000000000000000000000000000000123";
    expect(decodeMarketplaceLog(sold(release, 25n * 10n ** 15n, 25n * 10n ** 15n), { chainId: 43114, expectedAddress: UNIFIED, platformFeeBps: fee })).toMatchObject({ platformFeeWei: "25000000000000000" });
    expect(() => decodeMarketplaceLog(sold(release, 0, 25n * 10n ** 15n), { chainId: 43114, expectedAddress: UNIFIED, platformFeeBps: fee })).toThrow(/platform fee/);
  });

  it("decodes SaleSettled with its asset class and royalty recipient", () => {
    const log = { ...ref, ...abi.encodeEventLog("SaleSettled", [1, 2, CREATOR, 95n * 10n ** 16n]) };
    expect(decodeMarketplaceLog(log, { chainId: 43114, expectedAddress: UNIFIED })).toMatchObject({ eventType: "SaleSettled", assetClass: "GENESIS", royaltyReceiver: CREATOR.toLowerCase(), sellerProceedsWei: "950000000000000000", listingId: "1" });
  });
});

describe("genesisTokenChoices", () => {
  it("offers each Genesis id 0-3 only for the multi-token Genesis entry on the active chain, never for factory editions", async () => {
    const { genesisTokenChoices } = await import("./secondary-listing.js");
    expect(genesisTokenChoices({ chainId: 43114, contractAddress: GENESIS, tokenIds: [0, 1, 2, 3] }, active)).toEqual(["0", "1", "2", "3"]);
    expect(genesisTokenChoices({ chainId: 43114, contractAddress: GENESIS, tokenIds: [0, 1, 2, 3, 4] }, active)).toBeNull();
    expect(genesisTokenChoices({ chainId: 43114, contractAddress: GENESIS, tokenIds: [0] }, active)).toBeNull();
    expect(genesisTokenChoices({ chainId: 43113, contractAddress: GENESIS, tokenIds: [0, 1] }, active)).toBeNull();
    expect(genesisTokenChoices({ chainId: 43114, contractAddress: "0x0000000000000000000000000000000000000123", tokenIds: ["1", "2"] }, active)).toBeNull();
    expect(genesisTokenChoices({ chainId: 43114, contractAddress: GENESIS, tokenIds: [0, 1] }, { ...active, deployed: false })).toBeNull();
  });
});
