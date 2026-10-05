// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CollectPanel } from "./CollectPanel.jsx";
import { WalletCtx } from "../lib/wallet-context.js";
import { VOIDCALLER_CATALOG } from "../data.js";

const mocks = vi.hoisted(() => ({
  balance: vi.fn(),
  primarySale: vi.fn(),
}));

vi.mock("../lib/release-asset.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readReleaseBalance: mocks.balance };
});

vi.mock("../lib/primary-sale.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readReleasePrimarySale: mocks.primarySale };
});

const sourceEdition = VOIDCALLER_CATALOG.editions[0];
const release = VOIDCALLER_CATALOG.releases.find((item) => item.id === sourceEdition.releaseId);
const edition = {
  ...sourceEdition,
  id: "factory-release-owned-edition",
  chainId: 43113,
  contractAddress: "0x82b26da27136935454bdf1e40801190b521b82e5",
  primarySaleAddress: "0x8b743f91940a267899986d2e99b4375e1d87c321",
  tokenIds: ["987654321012345678901234567890123456789"],
};
const wallet = {
  connected: true,
  authenticated: true,
  account: "0xabd3746e8b852f55be52fc44fab6cab908b1c174",
  ownershipRecords: [],
  getProvider: () => ({ request: vi.fn() }),
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CollectPanel owner resale action", () => {
  it("keeps the existing experience action and adds the owner’s resale destination only after on-chain ownership is read", async () => {
    mocks.balance.mockResolvedValue(1n);
    mocks.primarySale.mockResolvedValue(null);
    const experience = { id: "factory-release-experience", title: "Open Door" };

    render(
      <MemoryRouter>
        <WalletCtx.Provider value={wallet}>
          <CollectPanel edition={edition} release={release} experiences={[experience]} variant="hero" />
        </WalletCtx.Provider>
      </MemoryRouter>,
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(screen.getByText("Owned")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open experience" }).getAttribute("href")).toBe("/experience/factory-release-experience");
    expect(screen.getByRole("link", { name: "List for sale" }).getAttribute("href")).toBe("/edition/factory-release-owned-edition#secondary-listing");
    expect(screen.getByText("You own this edition. You can list it for resale.")).toBeTruthy();
  });
});
