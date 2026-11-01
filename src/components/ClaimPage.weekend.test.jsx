/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  allocation: "0", publicAllocation: "0", claimStart: String(NOW - 600), claimEnd: String(NOW + 3600), activationDeadline: String(NOW + 86_400), claimDuration: "86400", active: true, paused: false,
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
  it("titles the landing Forgive & Forget and counts this window's claims apart from the carried-over baseline", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend({ claimedSupply: "12", baselineClaimedSupply: "5" }));
    renderLanding();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Forgive & Forget");
    const counter = await screen.findByTestId("claim-counter");
    expect(counter.querySelector(".vc-countdown-value").textContent).toBe("7");
    expect(counter.textContent).toMatch(/12 Genesis claims all time, including 5 from earlier claims/);
  });

  it("lets a holder claim right on the landing while the claim is open, with no link to another page", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend());
    catalogState.catalog = catalog();
    renderLanding();
    const embedded = await screen.findByTestId("embedded-claim");
    expect(embedded.textContent).toMatch(/Claim status/);
    const scope = within(embedded);
    expect(scope.getByRole("button", { name: /connect/i })).toBeTruthy();
    expect(scope.getByRole("button", { name: /claim/i })).toBeTruthy();
    expect(await scope.findByRole("link", { name: /MINT · 0\.25 AVAX/ })).toBeTruthy();
    expect(scope.getByRole("link", { name: /View release/i })).toBeTruthy();
    expect(screen.queryByText("OPEN THE RELEASE CLAIM")).toBeNull();
  });

  it.each([
    ["paused while active", { paused: true }],
    ["after the window closed, paid mint still open", { claimStart: String(NOW - 90_000), claimEnd: String(NOW - 3600) }],
    ["after the window closed and the paid mint ended", { claimStart: String(NOW - 90_000), claimEnd: String(NOW - 3600), publicSaleEnd: String(NOW - 60) }],
    ["never activated before the deadline", { active: false, paused: true, claimStart: "0", claimEnd: "0", activationDeadline: String(NOW - 600) }],
  ])("shows no claim controls on the landing when %s", async (_label, overrides) => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend(overrides));
    catalogState.catalog = catalog();
    renderLanding();
    await screen.findByText(/Verified claim target/);
    expect(screen.queryByTestId("embedded-claim")).toBeNull();
    expect(screen.queryByText("OPEN THE RELEASE CLAIM")).toBeNull();
  });

  it("shows no claim controls when the claim target fails to load", async () => {
    fetchGenesisClaimConfig.mockRejectedValue(new Error("Claim service is unavailable."));
    catalogState.catalog = catalog();
    renderLanding();
    await screen.findByText(/No claim target is configured and verified/);
    expect(screen.queryByTestId("embedded-claim")).toBeNull();
  });

  it("keeps the paid mint and release reachable from the landing after the free claim closes", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend({ claimStart: String(NOW - 90_000), claimEnd: String(NOW - 3600) }));
    catalogState.catalog = catalog();
    renderLanding();
    const mint = within(await screen.findByTestId("landing-mint"));
    expect(mint.getByRole("link", { name: /MINT · 0\.25 AVAX/ }).getAttribute("href")).toBe(`/edition/${EDITION_ID}`);
    expect(mint.getByRole("link", { name: /View release/i }).getAttribute("href")).toBe(`/edition/${EDITION_ID}`);
    expect(screen.queryByTestId("embedded-claim")).toBeNull();
  });

  it("offers no mint on the landing once the paid mint has ended too", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend({ claimStart: String(NOW - 90_000), claimEnd: String(NOW - 3600), publicSaleEnd: String(NOW - 60) }));
    catalogState.catalog = catalog();
    renderLanding();
    await screen.findByText(/Minting is closed/);
    expect(screen.queryByTestId("landing-mint")).toBeNull();
  });

  it("shows no claim controls on the landing before the claim is activated", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend({ active: false, paused: true, claimStart: "0", claimEnd: "0" }));
    catalogState.catalog = catalog();
    renderLanding();
    await screen.findByText(/has not opened/);
    expect(screen.queryByTestId("embedded-claim")).toBeNull();
    expect(screen.queryByText("OPEN THE RELEASE CLAIM")).toBeNull();
  });

  it("labels the count all-time, not this window, when the API does not send the carried-over baseline", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend({ claimedSupply: "6" }));
    renderLanding();
    const counter = await screen.findByTestId("claim-counter");
    expect(counter.querySelector(".vc-countdown-value").textContent).toBe("6");
    expect(counter.querySelector(".vc-countdown-label").textContent).toBe("all time");
    expect(counter.textContent).not.toMatch(/claimed/);
  });

  it("shows no claim counter before the claim is activated", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend({ active: false, paused: true, claimStart: "0", claimEnd: "0", claimedSupply: "5", baselineClaimedSupply: "5" }));
    renderLanding();
    await screen.findByText(/has not opened/);
    expect(screen.queryByTestId("claim-counter")).toBeNull();
  });

  it("lets a Grotto-only holder claim on C-Chain with its proof, without a voucher", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend());
    readGenesisClaimed.mockResolvedValue(false);
    checkGenesisEligibility.mockResolvedValue({ eligible: true, wallet: WALLET, sources: ["grotto"], proof: PROOF, claimContract: CLAIM, active: true, paused: false });
    executeWeekendClaim.mockResolvedValue({ transactionHash: `0x${"cd".repeat(32)}`, balance: 1n });
    renderEditionClaim();
    expect(await screen.findByText(/verified on The Grotto\. This grants one free claim on Avalanche C-Chain/)).toBeTruthy();
    expect(screen.getByText(/keep a small amount of AVAX on C-Chain for gas\. Nothing is bridged or moved from The Grotto/)).toBeTruthy();
    expect(screen.getByTestId("grotto-holder-notice").textContent).toMatch(/Your Grotto wallet will not\s+claim for you automatically/);
    const button = screen.getByRole("button", { name: "CLAIM FREE" });
    fireEvent.click(button);
    await waitFor(() => expect(executeWeekendClaim).toHaveBeenCalledWith(provider, expect.objectContaining({ mode: "weekend-merkle" }), WALLET, PROOF));
    expect(await screen.findByText(/Receipt confirmed/)).toBeTruthy();
    expect(requestGenesisVoucher).not.toHaveBeenCalled();
  });

  it("re-checks the target before signing and sends nothing if the owner paused it meanwhile", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend());
    readGenesisClaimed.mockResolvedValue(false);
    checkGenesisEligibility.mockResolvedValue({ eligible: true, wallet: WALLET, sources: ["c-chain"], proof: PROOF });
    renderEditionClaim();
    const button = await screen.findByRole("button", { name: "CLAIM FREE" });
    fetchGenesisClaimConfig.mockResolvedValue(weekend({ paused: true }));
    fireEvent.click(button);
    expect(await screen.findByText(/Genesis claim is paused/)).toBeTruthy();
    expect(executeWeekendClaim).not.toHaveBeenCalled();
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
    fetchGenesisClaimConfig.mockResolvedValue(weekend({ active: false, paused: true, claimStart: "0", claimEnd: "0" }));
    renderEditionClaim();
    expect(await screen.findByText(/Genesis claim has not opened/)).toBeTruthy();
    expect(screen.queryByTestId("weekend-claim-countdown")).toBeNull();
    expect(screen.queryByRole("button", { name: "CLAIM FREE" })).toBeNull();
    expect(checkGenesisEligibility).not.toHaveBeenCalled();
    cleanup();
    fetchGenesisClaimConfig.mockResolvedValue(weekend({ paused: true }));
    renderEditionClaim();
    expect(await screen.findByText(/Genesis claim is paused/)).toBeTruthy();
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
    expect((await screen.findAllByText(/switch this same wallet to .* \(43113\) to claim/i)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/Your wallet is on The Grotto\. The claim happens on/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Grotto Genesis tokens stay where they are and still count/).length).toBeGreaterThan(0);
    expect(checkGenesisEligibility).not.toHaveBeenCalled();
    cleanup();
    renderEditionClaim({ connected: false });
    expect(await screen.findByText(/Connect a wallet to verify Genesis ownership/)).toBeTruthy();
  });

  it("counts down to the contract's claimEnd, not to anything computed in the browser", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend({ claimStart: String(NOW - 82_800), claimEnd: String(NOW + 3600) }));
    readGenesisClaimed.mockResolvedValue(false);
    checkGenesisEligibility.mockResolvedValue({ eligible: true, wallet: WALLET, sources: ["c-chain"], proof: PROOF });
    renderEditionClaim();
    const countdown = await screen.findByTestId("weekend-claim-countdown");
    // One hour left of the on-chain window (claimStart + 24h = claimEnd), whatever the claim's start.
    expect(countdown.textContent).toMatch(/Genesis claim closes in/);
    expect(countdown.textContent).toMatch(/0 hours and 59 minutes left to claim|1 hours and 0 minutes left to claim/);
    expect(countdown.querySelector("time").getAttribute("datetime")).toBe(new Date((NOW + 3600) * 1000).toISOString());
  });

  it("stops offering the claim when the on-chain close is reached while the page is open", async () => {
    const closesAt = Math.floor(Date.now() / 1000) + 2;
    fetchGenesisClaimConfig.mockResolvedValue(weekend({ claimEnd: String(closesAt) }));
    readGenesisClaimed.mockResolvedValue(false);
    checkGenesisEligibility.mockResolvedValue({ eligible: true, wallet: WALLET, sources: ["c-chain"], proof: PROOF });
    renderEditionClaim();
    expect(await screen.findByRole("button", { name: "CLAIM FREE" })).toBeTruthy();
    expect(await screen.findByText(/The 24-hour Genesis claim window has closed/, {}, { timeout: 4000 })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "CLAIM FREE" })).toBeNull());
    expect(await screen.findByText(/The Genesis claim has closed. The public mint is open/)).toBeTruthy();
    expect(executeWeekendClaim).not.toHaveBeenCalled();
  });

  it("re-reads the verified target while not yet activated, so the opened claim appears without a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchGenesisClaimConfig.mockResolvedValue(weekend({ active: false, paused: true, claimStart: "0", claimEnd: "0" }));
      renderLanding();
      expect(await screen.findByText(/Genesis claim has not opened/)).toBeTruthy();
      fetchGenesisClaimConfig.mockResolvedValue(weekend({ claimStart: String(NOW), claimEnd: String(NOW + 86_400) }));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await screen.findByTestId("weekend-claim-countdown")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a claim never activated before its deadline as closed, not as upcoming", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend({ active: false, paused: true, claimStart: "0", claimEnd: "0", activationDeadline: String(NOW - 1) }));
    renderEditionClaim();
    expect(await screen.findByText(/The Genesis claim has closed. The public mint is open/)).toBeTruthy();
    expect(screen.queryByTestId("weekend-claim-countdown")).toBeNull();
  });

  it("explains the dual-chain snapshot on the landing page without the old countdown", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(weekend());
    const { container } = renderLanding();
    expect(await screen.findByText(/Genesis holders on Avalanche C-Chain or The Grotto at the snapshot can claim one copy free/)).toBeTruthy();
    expect(container.textContent).toMatch(/C-Chain block 99060000, Grotto block 151791/);
    expect(screen.getByTestId("grotto-holder-notice").textContent).toMatch(/free claim happens on .*, not on The Grotto/);
  });
});
