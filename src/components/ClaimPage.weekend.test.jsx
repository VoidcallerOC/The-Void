/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";

const { fetchGenesisClaimConfig, requestGenesisVoucher, readGenesisClaimed, checkGenesisEligibility, executeWeekendClaim, catalogState } = vi.hoisted(() => ({
  fetchGenesisClaimConfig: vi.fn(), requestGenesisVoucher: vi.fn(), readGenesisClaimed: vi.fn(), checkGenesisEligibility: vi.fn(), executeWeekendClaim: vi.fn(),
  catalogState: { catalog: { artists: [], releases: [], editions: [], experiences: [] } },
}));
vi.mock("../lib/genesis-claim.js", async (importOriginal) => ({ ...(await importOriginal()), fetchGenesisClaimConfig, requestGenesisVoucher, readGenesisClaimed, checkGenesisEligibility, executeWeekendClaim }));
vi.mock("../lib/catalog-source.js", async (importOriginal) => ({ ...(await importOriginal()), useMarketplaceCatalogs: () => catalogState.catalog }));

import { ClaimPage } from "./ClaimPage.jsx";

const NOW = Math.floor(Date.now() / 1000);
// The test build binds releases on Fuji (43113); the weekend page logic does not depend on the chain id.
const RELEASE = "0x2222222222222222222222222222222222222222";
const SALE = "0x3333333333333333333333333333333333333333";
const CLAIM = "0x4444444444444444444444444444444444444444";
const WALLET = "0x626b1AeAdB9Fc0b465B40aDE4F4bBF0C01C9Db40";
const EDITION_ID = "edition-ff";
const PROOF = [`0x${"aa".repeat(32)}`, `0x${"bb".repeat(32)}`];

const weekend = (overrides = {}) => ({
  enabled: true, mode: "weekend-merkle", destinationChainId: 43113, releaseContract: RELEASE, primarySale: SALE, claimContract: CLAIM, tokenId: "1",
  allocation: "0", publicAllocation: "0", claimStart: String(NOW - 600), claimEnd: String(NOW + 3600), active: true, paused: false,
  publicSaleStart: "1793019600", publicSaleEnd: String(NOW + 9 * 86_400), publicPriceWei: "250000000000000000",
  snapshotCChainBlock: "99060000", snapshotGrottoBlock: "151791", eligibility: "snapshot", ...overrides,
});

const catalog = () => ({
  artists: [{ id: "voidcaller", name: "Voidcaller" }],
  releases: [{ id: "rel-ff", artistId: "voidcaller", title: "Forgive & Forget", experiences: [] }],
  editions: [{
    id: EDITION_ID, releaseId: "rel-ff", title: "Forgive & Forget", chainId: 43113, releaseContractAddress: RELEASE, primarySaleAddress: SALE,
    factoryAddress: "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505", tokenIds: ["1"], publicationArchitecture: "release-per-contract",
  }],
  experiences: [],
});

const provider = { request: vi.fn() };
function renderEditionClaim({ chainId = 43113, connected = true } = {}) {
  catalogState.catalog = catalog();
  return render(
    <WalletCtx.Provider value={{ connected, account: connected ? WALLET : "", chainId: connected ? chainId : null, getProvider: () => provider }}>
      <MemoryRouter initialEntries={[`/claim/${EDITION_ID}`]}>
        <Routes><Route path="/claim/:edition" element={<ClaimPage />} /></Routes>
      </MemoryRouter>
    </WalletCtx.Provider>,
  );
}
function renderLanding() {
  return render(
    <WalletCtx.Provider value={{ connected: false, account: "", chainId: null, getProvider: () => null }}>
      <MemoryRouter initialEntries={["/claim"]}>
        <Routes><Route path="/claim" element={<ClaimPage />} /></Routes>
      </MemoryRouter>
    </WalletCtx.Provider>,
  );
}

afterEach(() => { cleanup(); vi.clearAllMocks(); catalogState.catalog = { artists: [], releases: [], editions: [], experiences: [] }; });

describe("Genesis weekend claim page", () => {
  it("lets a Grotto-only holder claim on C-Chain with its proof, without a voucher", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend());
    readGenesisClaimed.mockResolvedValue(false);
    checkGenesisEligibility.mockResolvedValue({ eligible: true, wallet: WALLET, sources: ["grotto"], proof: PROOF, claimContract: CLAIM, active: true, paused: false });
    executeWeekendClaim.mockResolvedValue({ transactionHash: `0x${"cd".repeat(32)}`, balance: 1n });
    renderEditionClaim();
    expect(await screen.findByText(/verified on The Grotto\. This grants one free claim on Avalanche C-Chain/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "CLAIM FREE" });
    fireEvent.click(button);
    await waitFor(() => expect(executeWeekendClaim).toHaveBeenCalledWith(provider, expect.objectContaining({ mode: "weekend-merkle" }), WALLET, PROOF));
    expect(await screen.findByText(/Receipt confirmed/)).toBeTruthy();
    expect(requestGenesisVoucher).not.toHaveBeenCalled();
  });

  it("names both chains for a holder on C-Chain and The Grotto", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend());
    readGenesisClaimed.mockResolvedValue(false);
    checkGenesisEligibility.mockResolvedValue({ eligible: true, wallet: WALLET, sources: ["c-chain", "grotto"], proof: PROOF });
    renderEditionClaim();
    expect(await screen.findByText(/verified on Avalanche C-Chain and The Grotto/)).toBeTruthy();
  });

  it("shows already claimed from any earlier claim contract", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend());
    readGenesisClaimed.mockResolvedValue(true);
    renderEditionClaim();
    expect(await screen.findByText(/already used its one Genesis-holder claim/)).toBeTruthy();
    expect(checkGenesisEligibility).not.toHaveBeenCalled();
  });

  it("shows not eligible for a wallet outside the snapshot", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend());
    readGenesisClaimed.mockResolvedValue(false);
    checkGenesisEligibility.mockResolvedValue({ eligible: false, reason: "NOT_IN_SNAPSHOT", wallet: WALLET });
    renderEditionClaim();
    expect(await screen.findByText(/held no Genesis token on Avalanche C-Chain or The Grotto at the snapshot/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "CLAIM UNAVAILABLE" }).disabled).toBe(true);
  });

  it("offers nothing to claim before activation or while paused", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend({ active: false, paused: true, claimStart: "0" }));
    renderEditionClaim();
    expect(await screen.findByText(/weekend claim has not opened/)).toBeTruthy();
    expect(checkGenesisEligibility).not.toHaveBeenCalled();
    cleanup();
    fetchGenesisClaimConfig.mockResolvedValue(weekend({ paused: true }));
    renderEditionClaim();
    expect(await screen.findByText(/weekend claim is paused/)).toBeTruthy();
  });

  it("shows the claim closed after claimEnd while the paid mint stays open", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend({ claimEnd: String(NOW - 1) }));
    renderEditionClaim();
    expect(await screen.findByText(/The Genesis claim has closed. The public mint is open/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^MINT · 0\.25 AVAX$/ })).toBeTruthy();
  });

  it("asks a wallet still on The Grotto to switch to the claim network, and a disconnected visitor to connect", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend());
    renderEditionClaim({ chainId: 36463 });
    expect((await screen.findAllByText(/switch your wallet to .* \(43113\) to claim/i)).length).toBeGreaterThan(0);
    expect(checkGenesisEligibility).not.toHaveBeenCalled();
    cleanup();
    renderEditionClaim({ connected: false });
    expect(await screen.findByText(/Connect a wallet to verify Genesis ownership/)).toBeTruthy();
  });

  it("explains the dual-chain snapshot on the landing page without the old countdown", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend());
    const { container } = renderLanding();
    expect(await screen.findByText(/Genesis holders on Avalanche C-Chain or The Grotto at the snapshot can claim one copy free/)).toBeTruthy();
    expect(container.textContent).toMatch(/C-Chain block 99060000, Grotto block 151791/);
  });
});
