/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";

const { fetchGenesisClaimConfig, requestGenesisVoucher } = vi.hoisted(() => ({ fetchGenesisClaimConfig: vi.fn(), requestGenesisVoucher: vi.fn() }));
vi.mock("../lib/genesis-claim.js", async (importOriginal) => ({ ...(await importOriginal()), fetchGenesisClaimConfig, requestGenesisVoucher }));
vi.mock("../lib/catalog-source.js", async (importOriginal) => ({ ...(await importOriginal()), useMarketplaceCatalogs: () => ({ artists: [], releases: [], editions: [], experiences: [] }) }));

import { ClaimPage } from "./ClaimPage.jsx";

const NOW = Math.floor(Date.now() / 1000);
const target = (claimStart) => ({
  enabled: true, destinationChainId: 43113, releaseContract: "0x2222222222222222222222222222222222222222", primarySale: "0x3333333333333333333333333333333333333333",
  claimContract: "0x4444444444444444444444444444444444444444", tokenId: "77", allocation: "0", publicAllocation: "0",
  claimStart: String(claimStart), claimEnd: String(claimStart + 86_400), publicSaleEnd: String(claimStart + 8 * 86_400 - 1),
  publicPriceWei: "250000000000000000", snapshotBlock: "97000000", snapshotBlockHash: `0x${"5a".repeat(32)}`,
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

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Genesis claim landing", () => {
  it("shows a closed notice and no historical rehearsal address when no claim is configured", async () => {
    fetchGenesisClaimConfig.mockRejectedValue(Object.assign(new Error("The Genesis holder claim is not configured."), { code: "CLAIM_UNAVAILABLE", status: 503 }));
    const { container } = renderClaim();
    expect(await screen.findByText(/The Genesis claim is not open/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/0x1AaF66f0aBA020321e63d684186886A3178A9BfC/i);
    expect(container.textContent).not.toMatch(/Rehearsal/i);
  });

  it("shows the verified target, the snapshot and the free claim during the Genesis window", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(target(NOW - 60));
    const { container } = renderClaim();
    expect(await screen.findByText(/Genesis holders can claim one copy for free/)).toBeTruthy();
    expect(container.textContent).toContain("0x2222222222222222222222222222222222222222");
    expect(container.textContent).toContain("block 97000000");
    expect(container.textContent).toContain("Open edition · uncapped");
    expect(requestGenesisVoucher).not.toHaveBeenCalled();
  });

  it("shows the ungated public mint at 0.25 AVAX after the Genesis window", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(target(NOW - 86_400 - 60));
    renderClaim();
    expect(await screen.findByText(/public mint is open to anyone for 0.25 AVAX/)).toBeTruthy();
    expect(screen.getByText(/No Genesis token or voucher is needed/)).toBeTruthy();
  });

  it("shows minting closed after the public window", async () => {
    fetchGenesisClaimConfig.mockResolvedValue(target(NOW - 9 * 86_400));
    renderClaim();
    expect(await screen.findByText(/Minting is closed/)).toBeTruthy();
  });
});
