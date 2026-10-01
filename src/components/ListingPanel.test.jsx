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
    FUJI_LISTING_CONFIG: actual.resolveFujiListingConfig({
      VITE_FUJI_LISTING_MARKETPLACE_ADDRESS: "0xa03b4b6e384c1d2718b837cd78e6408754aa0c0b",
      VITE_FUJI_LISTING_CHAIN_ID: "43113",
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

function markupFor(owned, selectedEdition = edition, chainId = FUJI_RELEASE_CONFIG.chainId) {
  const wallet = {
    account: seller,
    authenticated: false,
    authHeaders: {},
    chainId,
    connected: true,
    getProvider: () => null,
    owned,
  };
  return renderToStaticMarkup(
    React.createElement(WalletCtx.Provider, { value: wallet }, React.createElement(ListingPanel, { edition: selectedEdition })),
  );
}

function listingButton(markup) {
  return markup.match(/<button\b[^>]*>LIST EDITION<\/button>/)?.[0] || null;
}

describe("ListingPanel Fuji ownership and target gating", () => {
  it("enables the normal listing control only for an owned canonical Fuji edition on Fuji", async () => {
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

  it("rejects the current C-Chain edition even when the wallet owns it", () => {
    const cchainEdition = {
      ...edition,
      id: "legacy-cchain-edition",
      chainId: 43114,
      contractAddress: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee",
      tokenIds: [1],
    };
    const owned = { cchain: new Set([1]) };
    const markup = markupFor(owned, cchainEdition, 43114);

    expect(listingButton(markup)).toContain("disabled");
    expect(markup).toMatch(/C-Chain listing is disabled|only for editions on Avalanche Fuji/i);
  });

  it("rejects a noncanonical token even on Fuji", () => {
    const wrongTokenEdition = { ...edition, contractAddress: "0x262b774cf9a1949170b58e2d57f6189980fe757b" };
    const owned = { fuji: new Set([tokenId]) };
    const markup = markupFor(owned, wrongTokenEdition);

    expect(listingButton(markup)).toContain("disabled");
    expect(markup).toMatch(/canonical Fuji ERC-1155/i);
  });

  it("rejects a canonical edition while the connected wallet is on C-Chain", () => {
    const owned = { fuji: new Set([tokenId]) };
    const markup = markupFor(owned, edition, 43114);

    expect(listingButton(markup)).toContain("disabled");
    expect(markup).toMatch(/Connect your wallet to Avalanche Fuji/i);
  });
});
