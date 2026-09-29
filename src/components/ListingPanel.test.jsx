import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ListingPanel } from "./ListingPanel.jsx";
import { FUJI_RELEASE_CONFIG } from "../lib/fuji-release.js";
import { buildMarketplaceOwnershipConfig } from "../lib/marketplace-ownership.js";
import { WalletCtx } from "../lib/wallet-context.js";
import { checkCollectionOwnership } from "../lib/web3.js";

vi.mock("../lib/marketplace.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    MARKETPLACE_CONFIG: Object.freeze({
      ...actual.MARKETPLACE_CONFIG,
      address: "0x982b28352fd612fe934c5e1ad8fea399689190d2",
      chainId: 43113,
      enabled: true,
    }),
  };
});

const seller = "0xabd3746e8b852f55be52fc44fab6cab908b1c174";
const tokenId = "987654321012345678901234567890123456789";
const edition = {
  id: "fuji-edition",
  title: "Fuji edition",
  chainId: FUJI_RELEASE_CONFIG.chainId,
  contractAddress: FUJI_RELEASE_CONFIG.contractAddress,
  tokenIds: [tokenId],
};
const zeroWord = `0x${"0".repeat(64)}`;
const oneWord = `0x${"0".repeat(63)}1`;
const ownershipConfig = buildMarketplaceOwnershipConfig([edition]);

function markupFor(owned) {
  const wallet = {
    account: seller,
    authenticated: false,
    authHeaders: {},
    chainId: FUJI_RELEASE_CONFIG.chainId,
    connected: true,
    getProvider: () => null,
    owned,
  };
  return renderToStaticMarkup(
    React.createElement(WalletCtx.Provider, { value: wallet }, React.createElement(ListingPanel, { edition })),
  );
}

function listingButton(markup) {
  return markup.match(/<button\b[^>]*>LIST EDITION<\/button>/)?.[0] || null;
}

describe("ListingPanel Fuji ownership gating", () => {
  it("enables the normal listing control only after the canonical Fuji balance check succeeds", async () => {
    const owned = await checkCollectionOwnership(seller, {
      ...ownershipConfig,
      rpc: async (_rpcUrl, target) => target.toLowerCase() === FUJI_RELEASE_CONFIG.contractAddress.toLowerCase() ? oneWord : zeroWord,
    });

    expect(owned.fuji.has(tokenId)).toBe(true);
    expect(listingButton(markupFor(owned))).not.toContain("disabled");
  });

  it("keeps the listing control disabled for a connected but unowned Fuji wallet", async () => {
    const owned = await checkCollectionOwnership(seller, { ...ownershipConfig, rpc: async () => zeroWord });
    const button = listingButton(markupFor(owned));

    expect(owned.fuji.has(tokenId)).toBe(false);
    expect(button).toContain("disabled");
  });
});
