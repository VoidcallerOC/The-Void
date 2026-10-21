import { describe, expect, it, vi } from "vitest";
import { Interface, getAddress } from "ethers";
import { LEGACY_COLLECTION_MARKETPLACE, isLegacyMarketplace, legacyCollectionFor, legacyMarketplaceActive } from "../../config/legacy-collection-marketplace.js";
import { MARKETPLACE_CONFIG, MARKETPLACE_SELECTORS, encodeCreateListing, encodeCreateListingWithMinProceeds, encodeSetMinSellerProceeds, marketplaceConfigForEdition, submitListing } from "./marketplace.js";
import { isLegacyCollectionCandidate, minimumSellerProceedsPerUnit, readLegacyListingContext, readReleaseListingContext } from "./secondary-listing.js";

const GENESIS = "0xD1B4367dd9f235f9ee61878019d66E31511E98eE";
const CREATOR = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";
const MARKET = "0x00000000000000000000000000000000000a11ce";
const FILTER = "0x000000000000AAeB6D7670E522A718067333cd4E";
const SELLER = "0xAe78E365285dB9BfA0FB231038f75f8f3Cc11588";
const active = Object.freeze({ ...LEGACY_COLLECTION_MARKETPLACE, deployed: true, marketplaceAddress: MARKET, deploymentBlock: 100 });

const MARKET_ABI = new Interface([
  "function platformFeeBps() view returns (uint256)", "function deploymentChainId() view returns (uint256)", "function paused() view returns (bool)",
  "function isSupported(address,uint256) view returns (bool)",
  "function previewSettlement(address,uint256,uint256) view returns (uint256,address,uint256,uint256)",
]);
const TOKEN_ABI = new Interface(["function balanceOf(address,uint256) view returns (uint256)", "function isApprovedForAll(address,address) view returns (bool)", "function operatorFilterRegistry() view returns (address)"]);
const FILTER_ABI = new Interface(["function isOperatorAllowed(address,address) view returns (bool)"]);

function providerFor({ chainId = 43114, balance = 2n, approved = false, paused = false, supported = true, feeBps = 250n, receiver = CREATOR, royaltyWei = 50_000_000_000_000_000n, previewReverts = false, filterAllows = true, noFilter = false } = {}) {
  return {
    request: vi.fn(async ({ method, params }) => {
      if (method === "eth_chainId") return `0x${BigInt(chainId).toString(16)}`;
      const { to, data } = params[0];
      const target = to.toLowerCase();
      if (target === MARKET.toLowerCase()) {
        const parsed = MARKET_ABI.parseTransaction({ data });
        if (parsed.name === "previewSettlement" && previewReverts) throw new Error("execution reverted");
        const values = { platformFeeBps: [feeBps], deploymentChainId: [43114n], paused: [paused], isSupported: [supported], previewSettlement: [25_000_000_000_000_000n, receiver, royaltyWei, 925_000_000_000_000_000n] }[parsed.name];
        return MARKET_ABI.encodeFunctionResult(parsed.name, values);
      }
      if (target === GENESIS.toLowerCase()) {
        const parsed = TOKEN_ABI.parseTransaction({ data });
        if (parsed.name === "operatorFilterRegistry" && noFilter) throw new Error("no such method");
        const values = { balanceOf: [balance], isApprovedForAll: [approved], operatorFilterRegistry: [FILTER] }[parsed.name];
        return TOKEN_ABI.encodeFunctionResult(parsed.name, values);
      }
      if (target === FILTER.toLowerCase()) return FILTER_ABI.encodeFunctionResult("isOperatorAllowed", [filterAllows]);
      throw new Error(`unexpected call to ${to}`);
    }),
  };
}
const input = (provider) => ({ provider, marketplaceAddress: MARKET, marketplaceChainId: 43114, tokenContractAddress: GENESIS, tokenId: "0", seller: SELLER });

describe("legacy-collection marketplace manifest", () => {
  it("is inert until a deployment is recorded: Genesis stays ineligible and no marketplace is selected", () => {
    expect(LEGACY_COLLECTION_MARKETPLACE.deployed).toBe(false);
    expect(legacyMarketplaceActive()).toBe(false);
    const edition = { chainId: 43114, contractAddress: GENESIS.toLowerCase(), tokenIds: ["0"] };
    expect(isLegacyCollectionCandidate(edition)).toBe(false);
    // Genesis is now a candidate only through the active unified marketplace, never through the legacy one.
    expect(isLegacyMarketplace(MARKET)).toBe(false);
  });

  it("scopes eligibility to the explicit collection, token range and chain only", () => {
    expect(legacyCollectionFor({ chainId: 43114, contractAddress: GENESIS.toLowerCase(), tokenId: "3" }, active)?.maxRoyaltyBps).toBe(500);
    expect(legacyCollectionFor({ chainId: 43114, contractAddress: GENESIS, tokenId: "4" }, active)).toBeNull();
    expect(legacyCollectionFor({ chainId: 43114, contractAddress: "0x1111111111111111111111111111111111111111", tokenId: "0" }, active)).toBeNull();
    expect(legacyCollectionFor({ chainId: 43113, contractAddress: GENESIS, tokenId: "0" }, active)).toBeNull();
    expect(legacyCollectionFor({ chainId: 43114, contractAddress: GENESIS, tokenId: "x" }, active)).toBeNull();
    expect(isLegacyCollectionCandidate({ chainId: 43114, contractAddress: GENESIS, tokenIds: ["2"] }, active)).toBe(true);
    expect(legacyMarketplaceActive({ ...active, deploymentBlock: null })).toBe(false);
    expect(legacyMarketplaceActive({ ...active, collections: [] })).toBe(false);
  });

  it("selects the legacy marketplace only for allowlisted editions and leaves factory editions untouched", () => {
    const base = Object.freeze({ ...MARKETPLACE_CONFIG, enabled: true, chainId: 43114, address: "0x0e77116142844478a55EEd2Ab79de9F93770F8f5" });
    expect(marketplaceConfigForEdition({ chainId: 43114, contractAddress: GENESIS, tokenIds: ["0"] }, base, active).address).toBe(MARKET);
    expect(marketplaceConfigForEdition({ chainId: 43114, contractAddress: GENESIS, tokenIds: ["0"] }, base, LEGACY_COLLECTION_MARKETPLACE).address).toBe(base.address);
    expect(marketplaceConfigForEdition({ chainId: 43114, contractAddress: "0x2222222222222222222222222222222222222222", tokenIds: ["0"] }, base, active).address).toBe(base.address);
  });
});

describe("readLegacyListingContext", () => {
  it("accepts an eligible Genesis holder and reports on-chain balance, approval, 250 bps fee and the live 500 bps royalty", async () => {
    const result = await readLegacyListingContext(input(providerFor()), active);
    expect(result).toMatchObject({ balance: "2", approved: false, marketplaceFeeBps: "250", royaltyBps: "500", chainId: 43114, tokenId: "0", marketplaceAddress: getAddress(MARKET), releaseContractAddress: getAddress(GENESIS) });
    expect(await readLegacyListingContext(input(providerFor({ approved: true })), active)).toMatchObject({ approved: true });
  });

  it("reports insufficient balance and missing approval without throwing, so the panel can explain them", async () => {
    expect(await readLegacyListingContext(input(providerFor({ balance: 0n })), active)).toMatchObject({ balance: "0" });
    expect(await readLegacyListingContext(input(providerFor({ approved: false })), active)).toMatchObject({ approved: false });
  });

  it("refuses an ineligible token, a different collection and the wrong marketplace", async () => {
    await expect(readLegacyListingContext({ ...input(providerFor()), tokenId: "9" }, active)).rejects.toMatchObject({ code: "UNSUPPORTED_RELEASE" });
    await expect(readLegacyListingContext({ ...input(providerFor()), tokenContractAddress: "0x1111111111111111111111111111111111111111" }, active)).rejects.toMatchObject({ code: "UNSUPPORTED_RELEASE" });
    await expect(readLegacyListingContext({ ...input(providerFor()), marketplaceAddress: "0x0e77116142844478a55EEd2Ab79de9F93770F8f5" }, active)).rejects.toMatchObject({ code: "MARKETPLACE_UNAVAILABLE" });
    await expect(readLegacyListingContext(input(providerFor({ supported: false })), active)).rejects.toMatchObject({ code: "UNSUPPORTED_RELEASE" });
  });

  it("refuses on a wrong network, a paused or mismatching marketplace, and an unsettleable royalty", async () => {
    await expect(readLegacyListingContext(input(providerFor({ chainId: 1 })), active)).rejects.toMatchObject({ code: "WRONG_NETWORK" });
    await expect(readLegacyListingContext(input(providerFor({ paused: true })), active)).rejects.toMatchObject({ code: "MARKETPLACE_UNAVAILABLE" });
    await expect(readLegacyListingContext(input(providerFor({ feeBps: 500n })), active)).rejects.toMatchObject({ code: "MARKETPLACE_UNAVAILABLE" });
    await expect(readLegacyListingContext(input(providerFor({ previewReverts: true })), active)).rejects.toMatchObject({ code: "MARKETPLACE_UNAVAILABLE" });
    await expect(readLegacyListingContext(input(providerFor({ receiver: "0x3333333333333333333333333333333333333333" })), active)).rejects.toMatchObject({ code: "UNSUPPORTED_RELEASE" });
  });

  it("surfaces an operator filter that blocks the marketplace, and tolerates a collection without one", async () => {
    await expect(readLegacyListingContext(input(providerFor({ filterAllows: false })), active)).rejects.toMatchObject({ code: "MARKETPLACE_UNAVAILABLE" });
    expect(await readLegacyListingContext(input(providerFor({ noFilter: true })), active)).toMatchObject({ balance: "2" });
  });

  it("is only reachable through readReleaseListingContext while the manifest is active (V4 path unchanged)", async () => {
    await expect(readReleaseListingContext({ ...input(providerFor()), releaseContractAddress: GENESIS })).rejects.toMatchObject({ code: "MARKETPLACE_UNAVAILABLE" });
  });
});

describe("seller minimum-proceeds floor (client side)", () => {
  const WEI = 10n ** 18n;
  it("derives the per-unit floor from the live fee and royalty, as the floor of the exact-rate share", () => {
    expect(minimumSellerProceedsPerUnit({ priceWei: WEI.toString(), marketplaceFeeBps: "250", royaltyBps: "500" })).toBe("925000000000000000");
    expect(minimumSellerProceedsPerUnit({ priceWei: "333", marketplaceFeeBps: "250", royaltyBps: "500" })).toBe("308");
    expect(minimumSellerProceedsPerUnit({ priceWei: WEI.toString(), marketplaceFeeBps: "250", royaltyBps: "0" })).toBe("975000000000000000");
    expect(minimumSellerProceedsPerUnit({ priceWei: WEI.toString(), marketplaceFeeBps: "250", royaltyBps: "500", toleranceBps: 200 })).toBe("905000000000000000");
    // At 1 wei the exact-rate share rounds to 0: no valid (non-zero) floor exists, so there is nothing to send.
    expect(minimumSellerProceedsPerUnit({ priceWei: "1", marketplaceFeeBps: "250", royaltyBps: "500" })).toBeNull();
    expect(minimumSellerProceedsPerUnit({ priceWei: "2", marketplaceFeeBps: "250", royaltyBps: "500" })).toBe("1");
  });

  it("refuses malformed inputs instead of producing a floor", () => {
    expect(minimumSellerProceedsPerUnit({ priceWei: "0", marketplaceFeeBps: "250", royaltyBps: "500" })).toBeNull();
    expect(minimumSellerProceedsPerUnit({ priceWei: "abc", marketplaceFeeBps: "250", royaltyBps: "500" })).toBeNull();
    expect(minimumSellerProceedsPerUnit({ priceWei: "100", marketplaceFeeBps: "9000", royaltyBps: "900", toleranceBps: 200 })).toBeNull();
  });

  it("is never above what the contract's floor-rounded settlement pays the seller, for any price and quantity (property check)", () => {
    for (const price of [1n, 7n, 39n, 40n, 333n, 999n, 12_345_678_901n, WEI, 3n * WEI + 1n]) {
      for (const royaltyBps of [0n, 1n, 250n, 500n, 999n, 1000n]) {
        const floorText = minimumSellerProceedsPerUnit({ priceWei: price, marketplaceFeeBps: 250, royaltyBps });
        if (floorText === null) continue; // no non-zero floor exists at this price; the app does not offer the listing
        const floor = BigInt(floorText);
        for (const quantity of [1n, 2n, 3n, 7n, 100n]) {
          const sale = price * quantity;
          const proceeds = sale - (sale * 250n) / 10_000n - (sale * royaltyBps) / 10_000n; // the contract's arithmetic
          expect(proceeds >= floor * quantity).toBe(true);
        }
      }
    }
  });
});

describe("protected listing transaction encoding", () => {
  const iface = new Interface([
    "function createListing(address,address,uint256,uint256,uint256,uint64)",
    "function createListingWithMinProceeds(address,address,uint256,uint256,uint256,uint64,uint256)",
    "function setMinSellerProceeds(uint256,uint256)",
  ]);
  const args = { contract: GENESIS, seller: SELLER, tokenId: "0", amount: "2", price: "1000000000000000000", expiresAt: 0 };

  it("encodes exactly what the ABI encodes and leaves the V4-shaped encoding untouched", () => {
    expect(encodeCreateListingWithMinProceeds({ ...args, minSellerProceedsPerUnit: "925000000000000000" }))
      .toBe(iface.encodeFunctionData("createListingWithMinProceeds", [GENESIS, SELLER, 0, 2, "1000000000000000000", 0, "925000000000000000"]).toLowerCase());
    expect(encodeSetMinSellerProceeds(5, "900")).toBe(iface.encodeFunctionData("setMinSellerProceeds", [5, 900]).toLowerCase());
    expect(encodeCreateListing(args)).toBe(iface.encodeFunctionData("createListing", [GENESIS, SELLER, 0, 2, "1000000000000000000", 0]).toLowerCase());
    expect(MARKETPLACE_SELECTORS.createListing).toBe("0x5201ea65");
  });

  it("will not encode a protected listing without a floor", () => {
    expect(() => encodeCreateListingWithMinProceeds(args)).toThrow(/minimum seller proceeds/i);
    expect(() => encodeCreateListingWithMinProceeds({ ...args, minSellerProceedsPerUnit: "-1" })).toThrow();
    expect(() => encodeCreateListingWithMinProceeds({ ...args, minSellerProceedsPerUnit: "0" })).toThrow(/non-zero/i);
    expect(() => encodeSetMinSellerProceeds(5, "0")).toThrow(/non-zero/i);
  });

  const chain = { id: 43114, chainId: 43114, hexId: "0xa86a" };
  function wallet() {
    const sent = [];
    return { sent, request: vi.fn(async ({ method, params }) => {
      if (method === "eth_chainId") return "0xa86a";
      if (method === "eth_sendTransaction") { sent.push(params[0]); return "0xabc"; }
      if (method === "eth_getTransactionReceipt") return { status: "0x1" };
      throw new Error(`unexpected ${method}`);
    }) };
  }
  const edition = { contractAddress: GENESIS };
  const listing = { owner: SELLER, edition, chain, chainId: 43114, tokenId: "0", amount: "2", price: "1000000000000000000", expiresAt: 0 };

  it("submits the protected function to the legacy marketplace, never the unprotected one, and refuses to submit without a floor", async () => {
    const provider = wallet();
    await submitListing({ ...listing, provider, marketplace: MARKET, minSellerProceedsPerUnit: "925000000000000000", legacy: active });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].to).toBe(MARKET);
    expect(provider.sent[0].data.startsWith("0x068773dd")).toBe(true);
    const blocked = wallet();
    await expect(submitListing({ ...listing, provider: blocked, marketplace: MARKET, legacy: active })).rejects.toThrow(/minimum seller proceeds/i);
    expect(blocked.sent).toHaveLength(0);
  });

  it("keeps the V4 marketplace on the original V4-shaped call", async () => {
    const provider = wallet();
    await submitListing({ ...listing, provider, marketplace: "0x0e77116142844478a55EEd2Ab79de9F93770F8f5", legacy: active });
    expect(provider.sent[0].data.startsWith("0x5201ea65")).toBe(true);
  });
});
