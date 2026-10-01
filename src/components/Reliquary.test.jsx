/** @vitest-environment jsdom */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Reliquary } from "./Reliquary.jsx";
import { VOIDCALLER_CATALOG } from "../data.js";
import { WalletCtx } from "../lib/wallet-context.js";

const contract = VOIDCALLER_CATALOG.editions[0].contractAddress;
const wallet = "0x1111111111111111111111111111111111111111";

function renderReliquary(ownershipRecords) {
  return renderToStaticMarkup(
    <WalletCtx.Provider value={{ connected: true, account: wallet, loadingOwnership: false, ownershipRecords, owned: {}, disconnect: () => {} }}>
      <Reliquary />
    </WalletCtx.Provider>,
  );
}

describe("Reliquary token breakdown", () => {
  it("renders each owned token independently and preserves ERC-1155 quantity", () => {
    const markup = renderReliquary([
      { wallet, contract, tokenId: "1", amount: 2, chain: { key: "cchain", id: 43114, name: "Avalanche C-Chain" }, updatedAt: 1 },
      { wallet, contract, tokenId: "2", amount: 1, chain: { key: "cchain", id: 43114, name: "Avalanche C-Chain" }, updatedAt: 1 },
    ]);
    expect(markup.match(/data-token-id=/g)).toHaveLength(2);
    expect(markup).toContain('data-token-id="1"');
    expect(markup).toContain('data-token-id="2"');
    expect(markup).toContain("TOKEN #1 · 2 owned");
    expect(markup).toContain("TOKEN #2 · 1 owned");
  });
});
