/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";

const { fetchGenesisClaimConfig, requestGenesisVoucher, readGenesisClaimed, checkGenesisEligibility, catalogState } = vi.hoisted(() => ({
  fetchGenesisClaimConfig: vi.fn(), requestGenesisVoucher: vi.fn(), readGenesisClaimed: vi.fn(), checkGenesisEligibility: vi.fn(),
  catalogState: { catalog: { artists: [], releases: [], editions: [], experiences: [] } },
}));
vi.mock("../lib/genesis-claim.js", async (importOriginal) => ({ ...(await importOriginal()), fetchGenesisClaimConfig, requestGenesisVoucher, readGenesisClaimed, checkGenesisEligibility }));
vi.mock("../lib/catalog-source.js", async (importOriginal) => ({ ...(await importOriginal()), useMarketplaceCatalogs: () => catalogState.catalog }));

import { ClaimPage } from "./ClaimPage.jsx";

const NOW = Math.floor(Date.now() / 1000);
const RELEASE = "0x2222222222222222222222222222222222222222";
const SALE = "0x3333333333333333333333333333333333333333";
const WALLET = "0x1111111111111111111111111111111111111111";
// Concurrent phases: the paid mint opens with the claims (publicSaleStart == claimStart), claims run
// 24h, the sale 7 days (endTime inclusive).
const target = (claimStart) => ({
  enabled: true, destinationChainId: 43113, releaseContract: RELEASE, primarySale: SALE,
  claimContract: "0x4444444444444444444444444444444444444444", tokenId: "77", allocation: "0", publicAllocation: "0",
  claimStart: String(claimStart), claimEnd: String(claimStart + 86_400), publicSaleStart: String(claimStart), publicSaleEnd: String(claimStart + 7 * 86_400 - 1),
  publicPriceWei: "250000000000000000", eligibility: "live",
});

// A catalog whose edition carries a valid factory-created release binding for the claim target.
const EDITION_ID = "ed-genesis";
const boundCatalog = () => ({
  artists: [{ id: "artist-1", name: "The Artist" }],
  releases: [{ id: "rel-1", artistId: "artist-1", title: "Genesis Edition", experiences: [] }],
  editions: [{
    id: EDITION_ID, releaseId: "rel-1", title: "Open edition", chainId: 43113, releaseContractAddress: RELEASE, primarySaleAddress: SALE,
    factoryAddress: "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505", tokenIds: ["77"], publicationArchitecture: "release-per-contract",
  }],
  experiences: [],
});

function renderClaim() {
  return render(
    <WalletCtx.Provider value={{ connected: false, account: "", chainId: null, getProvider: () => null }}>
      <MemoryRouter initialEntries={["/claim"]}>
        <Routes><Route path="/claim" element={<ClaimPage />} /></Routes>
      </MemoryRouter>
    </WalletCtx.Provider>,
  );
}

// One provider object for the page's lifetime: a fresh object per render would re-run the claim sync effect forever.
const provider = { request: vi.fn() };
function renderEditionClaim() {
  return render(
    <WalletCtx.Provider value={{ connected: true, account: WALLET, chainId: 43113, getProvider: () => provider }}>
      <MemoryRouter initialEntries={[`/claim/${EDITION_ID}`]}>
        <Routes><Route path="/claim/:edition" element={<ClaimPage />} /></Routes>
      </MemoryRouter>
    </WalletCtx.Provider>,
  );
}

const mintLink = () => screen.queryByRole("link", { name: /^MINT · 0\.25 AVAX$/ });

afterEach(() => { cleanup(); vi.clearAllMocks(); catalogState.catalog = { artists: [], releases: [], editions: [], experiences: [] }; });

describe("Genesis claim landing", () => {
  it("shows a closed notice and no historical rehearsal address when no claim is configured", async () => {
    fetchGenesisClaimConfig.mockRejectedValue(Object.assign(new Error("The Genesis holder claim is not configured."), { code: "CLAIM_UNAVAILABLE", status: 503 }));
    const { container } = renderClaim();
    expect(await screen.findByText(/The Genesis claim is not open/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/0x1AaF66f0aBA020321e63d684186886A3178A9BfC/i);
    expect(container.textContent).not.toMatch(/Rehearsal/i);
  });

  it("shows the verified target, live eligibility, the free claim and the concurrent paid mint during the Genesis window", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(target(NOW - 60));
    const { container } = renderClaim();
    expect(await screen.findByText(/Genesis holders can claim one copy for free/)).toBeTruthy();
    expect(container.textContent).toMatch(/public mint is also open now to anyone for 0.25 AVAX/);
    expect(container.textContent).toContain("0x2222222222222222222222222222222222222222");
    expect(container.textContent).toContain("Currently holds Genesis token 0, 1, 2 or 3");
    expect(container.textContent).not.toMatch(/snapshot/i);
    expect(container.textContent).toContain("Open edition · uncapped");
    expect(requestGenesisVoucher).not.toHaveBeenCalled();
  });

  it("shows the ungated public mint at 0.25 AVAX after the Genesis window", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(target(NOW - 86_400 - 60));
    renderClaim();
    expect(await screen.findByText(/public mint is open to anyone for 0.25 AVAX/)).toBeTruthy();
    expect(screen.getByText(/No Genesis token or voucher is needed/)).toBeTruthy();
  });

  it("announces that the claim and the mint open together before the window", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(target(NOW + 3600));
    renderClaim();
    expect(await screen.findByText(/The free Genesis claim and the public mint open /)).toBeTruthy();
  });

  it("shows minting closed after the public window", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(target(NOW - 8 * 86_400));
    renderClaim();
    expect(await screen.findByText(/Minting is closed/)).toBeTruthy();
  });
});

describe("Genesis release claim with the concurrent paid mint", () => {
  it("offers the free claim to an eligible wallet and the paid mint beside it during the Genesis window", async () => {
    catalogState.catalog = boundCatalog();
    fetchGenesisClaimConfig.mockResolvedValue(target(NOW - 60));
    readGenesisClaimed.mockResolvedValue(false);
    checkGenesisEligibility.mockResolvedValue({ eligible: true, eligibleTokenIds: ["1"] });
    renderEditionClaim();
    const claim = await screen.findByRole("button", { name: "REQUEST CLAIM AUTHORIZATION" });
    expect(claim.disabled).toBe(false);
    expect(mintLink()).toBeTruthy();
    expect(mintLink().getAttribute("href")).toBe(`/edition/${EDITION_ID}`);
    expect(screen.getByText(/Genesis ownership verified/)).toBeTruthy();
  });

  it("still shows the paid mint to an ineligible wallet during the Genesis window", async () => {
    catalogState.catalog = boundCatalog();
    fetchGenesisClaimConfig.mockResolvedValue(target(NOW - 60));
    readGenesisClaimed.mockResolvedValue(false);
    checkGenesisEligibility.mockResolvedValue({ eligible: false, eligibleTokenIds: [] });
    renderEditionClaim();
    expect(await screen.findByText(/Access denied\. This wallet does not currently hold Genesis token/)).toBeTruthy();
    expect(mintLink()).toBeTruthy();
    expect(screen.getByRole("button", { name: "CLAIM UNAVAILABLE" }).disabled).toBe(true);
  });

  it("still shows the paid mint to a wallet that already claimed during the Genesis window", async () => {
    catalogState.catalog = boundCatalog();
    fetchGenesisClaimConfig.mockResolvedValue(target(NOW - 60));
    readGenesisClaimed.mockResolvedValue(true);
    renderEditionClaim();
    expect(await screen.findByText(/already used its one Genesis-holder claim/)).toBeTruthy();
    expect(mintLink()).toBeTruthy();
    expect(screen.getByRole("button", { name: "ALREADY CLAIMED" }).disabled).toBe(true);
    expect(checkGenesisEligibility).not.toHaveBeenCalled();
  });

  it("offers only the paid mint once the claims close, and nothing after the sale ends", async () => {
    catalogState.catalog = boundCatalog();
    readGenesisClaimed.mockResolvedValue(false);
    checkGenesisEligibility.mockResolvedValue({ eligible: true, eligibleTokenIds: ["1"] });
    fetchGenesisClaimConfig.mockResolvedValue(target(NOW - 86_400 - 60));
    renderEditionClaim();
    expect(await screen.findByText(/The Genesis claim has closed/)).toBeTruthy();
    expect(mintLink()).toBeTruthy();
    expect(screen.queryByRole("button", { name: /CLAIM/ })).toBeNull();
    cleanup();

    fetchGenesisClaimConfig.mockResolvedValue(target(NOW - 8 * 86_400));
    renderEditionClaim();
    expect(await screen.findByRole("button", { name: "MINTING CLOSED" })).toBeTruthy();
    expect(mintLink()).toBeNull();
  });
});
