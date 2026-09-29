import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WalletProvider } from "./WalletContext.jsx";
import { buildMarketplaceOwnershipConfig } from "./marketplace-ownership.js";
import { useWallet } from "./wallet-context.js";
import { FUJI_RELEASE_CONFIG } from "./fuji-release.js";

function OwnershipProbe() {
  const wallet = useWallet();
  const keys = Object.keys(wallet.owned).sort().join(",");
  return React.createElement("output", {
    "data-owned-chains": keys,
    "data-fuji-owned-count": String(wallet.owned.fuji?.size ?? -1),
  });
}

describe("WalletProvider marketplace ownership wiring", () => {
  it("initializes Fuji ownership alongside existing C-Chain and Grotto state", () => {
    const config = buildMarketplaceOwnershipConfig([{
      chainId: FUJI_RELEASE_CONFIG.chainId,
      contractAddress: FUJI_RELEASE_CONFIG.contractAddress,
      tokenIds: ["987654321012345678901234567890123456789"],
    }]);
    const markup = renderToStaticMarkup(
      React.createElement(WalletProvider, { collectionConfig: config }, React.createElement(OwnershipProbe)),
    );

    expect(markup).toContain('data-owned-chains="cchain,fuji,grotto"');
    expect(markup).toContain('data-fuji-owned-count="0"');
  });
});
