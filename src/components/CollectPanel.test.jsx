import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { CollectPanel } from "./CollectPanel.jsx";
import { VOIDCALLER_CATALOG } from "../data.js";
import { WalletCtx } from "../lib/wallet-context.js";

const wallet = { connected: false, account: null, ownershipRecords: [], owned: {} };
const edition = VOIDCALLER_CATALOG.editions.find((item) => item.id === "voidcaller-chapter-i");
const release = VOIDCALLER_CATALOG.releases.find((item) => item.id === edition.releaseId);

function renderPanel(experiences) {
  return renderToStaticMarkup(
    <WalletCtx.Provider value={wallet}>
      <MemoryRouter>
        <CollectPanel edition={edition} release={release} experiences={experiences} />
      </MemoryRouter>
    </WalletCtx.Provider>,
  );
}

describe("CollectPanel experience destinations", () => {
  it("routes Open experience to the linked experience, not the edition or reliquary", () => {
    const markup = renderPanel([{ id: "voidcaller-legacy-track-1", title: "The Hollow" }]);
    expect(markup).toContain('href="/experience/voidcaller-legacy-track-1"');
    expect(markup).toContain(">Open experience</a>");
    expect(markup).not.toContain('href="/reliquary">Open experience');
  });

  it("uses Open reliquary when no experience is linked", () => {
    const markup = renderPanel([]);
    expect(markup).toContain('href="/reliquary"');
    expect(markup).toContain(">Open reliquary</a>");
    expect(markup).not.toContain(">Open experience</a>");
  });
});
