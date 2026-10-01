import { describe, expect, it } from "vitest";
import { FUJI_LISTING_TARGET, fujiEditionHasTokenId, fujiListingTargetError, resolveFujiListingConfig } from "./marketplace.js";

const validEnv = {
  VITE_FUJI_LISTING_MARKETPLACE_ADDRESS: "0xa03b4b6e384c1d2718b837cd78e6408754aa0c0b",
  VITE_FUJI_LISTING_CHAIN_ID: "43113",
};
const validConfig = resolveFujiListingConfig(validEnv);
const fujiChain = { key: "fuji", id: 43113 };

const validTarget = {
  config: validConfig,
  marketplace: FUJI_LISTING_TARGET.marketplaceAddress,
  chain: fujiChain,
  chainId: 43113,
  editionChainId: 43113,
  tokenContract: FUJI_LISTING_TARGET.tokenAddress,
};

describe("Fuji marketplace listing target configuration", () => {
  it("enables only the certified marketplace, Fuji chain, and canonical token", () => {
    expect(validConfig).toMatchObject({
      address: FUJI_LISTING_TARGET.marketplaceAddress,
      chainId: 43113,
      tokenAddress: FUJI_LISTING_TARGET.tokenAddress,
      enabled: true,
      reason: "",
    });
    expect(fujiListingTargetError(validTarget)).toBeNull();
  });

  it.each([
    ["missing address", { VITE_FUJI_LISTING_CHAIN_ID: "43113" }],
    ["malformed address", { ...validEnv, VITE_FUJI_LISTING_MARKETPLACE_ADDRESS: "not-an-address" }],
    ["legacy marketplace", { ...validEnv, VITE_FUJI_LISTING_MARKETPLACE_ADDRESS: "0x982b28352fd612fe934c5e1ad8fea399689190d2" }],
    ["missing chain", { VITE_FUJI_LISTING_MARKETPLACE_ADDRESS: validEnv.VITE_FUJI_LISTING_MARKETPLACE_ADDRESS }],
    ["malformed chain", { ...validEnv, VITE_FUJI_LISTING_CHAIN_ID: "43113.5" }],
    ["wrong chain", { ...validEnv, VITE_FUJI_LISTING_CHAIN_ID: "43114" }],
  ])("fails closed for %s configuration", (_label, env) => {
    const config = resolveFujiListingConfig(env);
    expect(config.enabled).toBe(false);
    expect(config.address).toBe("");
    expect(config.chainId).toBe(0);
    expect(fujiListingTargetError({ ...validTarget, config })).toMatch(/disabled/i);
  });

  it("rejects the legacy marketplace even when the configured Fuji target is otherwise valid", () => {
    expect(fujiListingTargetError({
      ...validTarget,
      marketplace: "0x982b28352fd612fe934c5e1ad8fea399689190d2",
    })).toMatch(/only the certified Fuji marketplace/i);
  });

  it("rejects a C-Chain listing edition and a wallet not on Fuji", () => {
    expect(fujiListingTargetError({
      ...validTarget,
      chain: { key: "cchain", id: 43114 },
      chainId: 43114,
      editionChainId: 43114,
    })).toMatch(/only for editions on Avalanche Fuji/i);
    expect(fujiListingTargetError({ ...validTarget, chainId: 43114 })).toMatch(/connect your wallet to Avalanche Fuji/i);
    expect(fujiListingTargetError({ ...validTarget, editionChainId: 43114 })).toMatch(/edition is not on Avalanche Fuji/i);
  });

  it("rejects the legacy C-Chain token and any noncanonical Fuji token", () => {
    expect(fujiListingTargetError({
      ...validTarget,
      tokenContract: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee",
    })).toMatch(/only the canonical Fuji ERC-1155/i);
    expect(fujiListingTargetError({
      ...validTarget,
      tokenContract: "0x262b774cf9a1949170b58e2d57f6189980fe757b",
    })).toMatch(/only the canonical Fuji ERC-1155/i);
  });

  it("rejects an internally malformed target object", () => {
    expect(fujiListingTargetError({
      ...validTarget,
      config: { ...validConfig, tokenAddress: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee" },
    })).toMatch(/configuration is invalid/i);
  });

  it("accepts only token IDs declared by the canonical Fuji edition", () => {
    const edition = { chainId: 43113, contractAddress: FUJI_LISTING_TARGET.tokenAddress, tokenIds: ["5", "987654321012345678901234567890123456789"] };
    expect(fujiEditionHasTokenId(edition, 5)).toBe(true);
    expect(fujiEditionHasTokenId(edition, "987654321012345678901234567890123456789")).toBe(true);
    expect(fujiEditionHasTokenId(edition, 6)).toBe(false);
    expect(fujiEditionHasTokenId({ ...edition, tokenIds: [] }, 5)).toBe(false);
  });
});
