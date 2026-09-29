import { describe, expect, it } from "vitest";
import { mapPublishedCatalog } from "./catalog-source.js";
import { FUJI_RELEASE_CONFIG } from "./fuji-release.js";
import { buildMarketplaceOwnershipConfig } from "./marketplace-ownership.js";
import { checkCollectionOwnership, checkCollectionOwnershipRecords } from "./web3.js";

const seller = "0xabd3746e8b852f55be52fc44fab6cab908b1c174";
const tokenId = "987654321012345678901234567890123456789";
const zeroWord = `0x${"0".repeat(64)}`;
const oneWord = `0x${"0".repeat(63)}1`;
const padAddress = (address) => address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const padUint = (value) => BigInt(value).toString(16).padStart(64, "0");

function publishedFujiEdition(overrides = {}) {
  return {
    id: "fuji-edition",
    release_id: "fuji-release",
    title: "Fuji edition",
    status: "PUBLISHED",
    chain_id: FUJI_RELEASE_CONFIG.chainId,
    contract_address: FUJI_RELEASE_CONFIG.contractAddress,
    token_id: tokenId,
    ...overrides,
  };
}

function ownershipConfig(rows = [publishedFujiEdition()]) {
  const catalog = mapPublishedCatalog({ editions: rows });
  return { catalog, config: buildMarketplaceOwnershipConfig(catalog.editions) };
}

describe("Marketplace Fuji ownership configuration", () => {
  it("derives the canonical V2 chain and token IDs from catalog/API edition data", () => {
    const { catalog, config } = ownershipConfig();
    const edition = catalog.editions[0];

    expect(edition.tokenIds).toEqual([tokenId]);
    expect(config.chains.fuji).toMatchObject({
      id: 43113,
      key: "fuji",
      contract: "0x82b26Da27136935454Bdf1e40801190B521b82e5",
      tokenIds: [tokenId],
    });
    expect(config.chains.cchain).toEqual(expect.objectContaining({ id: 43114 }));
    expect(config.chains.grotto).toEqual(expect.objectContaining({ id: 36463 }));
  });

  it("excludes noncanonical Fuji editions and other chains from Fuji ownership reads", () => {
    const { config } = ownershipConfig([
      publishedFujiEdition(),
      publishedFujiEdition({ id: "legacy-fuji", contract_address: "0x262B774cf9a1949170B58E2d57F6189980FE757b", token_id: "77" }),
      publishedFujiEdition({ id: "other-chain", chain_id: 43114, token_id: "88" }),
    ]);

    expect(config.chains.fuji.contract.toLowerCase()).toBe(FUJI_RELEASE_CONFIG.contractAddress.toLowerCase());
    expect(config.chains.fuji.tokenIds).toEqual([tokenId]);
  });

  it("marks the Fuji edition owned only when canonical balanceOf is positive", async () => {
    const { catalog, config } = ownershipConfig();
    const calls = [];
    const rpc = async (rpcUrl, target, data) => {
      calls.push({ rpcUrl, target, data });
      return target.toLowerCase() === FUJI_RELEASE_CONFIG.contractAddress.toLowerCase() ? oneWord : zeroWord;
    };

    const owned = await checkCollectionOwnership(seller, { ...config, rpc });
    const fujiCall = calls.find((call) => call.target.toLowerCase() === FUJI_RELEASE_CONFIG.contractAddress.toLowerCase());

    expect(fujiCall.rpcUrl).toBe(FUJI_RELEASE_CONFIG.rpcUrl);
    expect(fujiCall.data).toBe(`0x00fdd58e${padAddress(seller)}${padUint(catalog.editions[0].tokenIds[0])}`);
    expect(owned.fuji.has(tokenId)).toBe(true);
  });

  it("keeps an unowned Fuji edition absent from both ownership sets and ownership records", async () => {
    const { config } = ownershipConfig();
    const rpc = async () => zeroWord;

    const owned = await checkCollectionOwnership(seller, { ...config, rpc });
    const records = await checkCollectionOwnershipRecords(seller, { ...config, rpc });

    expect(owned.fuji.has(tokenId)).toBe(false);
    expect(records.some((record) => record.chain.key === "fuji" && record.tokenId === tokenId)).toBe(false);
  });

  it("preserves the existing C-Chain and Grotto token checks", async () => {
    const { config } = ownershipConfig();
    const rpc = async (_rpcUrl, target, data) => {
      const id = BigInt(`0x${data.slice(2 + 8 + 64)}`);
      if (target.toLowerCase() === config.chains.cchain.contract.toLowerCase() && id === 1n) return oneWord;
      if (target.toLowerCase() === config.chains.grotto.contract.toLowerCase() && id === 2n) return oneWord;
      return zeroWord;
    };

    const owned = await checkCollectionOwnership(seller, { ...config, rpc });

    expect(owned.cchain.has(1)).toBe(true);
    expect(owned.grotto.has(2)).toBe(true);
    expect(owned.fuji.has(tokenId)).toBe(false);
  });
});
