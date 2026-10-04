/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { WalletCtx } from "../lib/wallet-context.js";
import { FUJI_RELEASE_CONFIG, FUJI_ROLES } from "../lib/fuji-release.js";

vi.mock("../lib/fuji-release.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readPublishingRoles: vi.fn(),
    readFujiRole: vi.fn(),
    grantPublishingRoles: vi.fn(),
  };
});

vi.mock("../lib/verification-api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchReviewApplication: vi.fn() };
});

const { readPublishingRoles, readFujiRole, grantPublishingRoles } = await import("../lib/fuji-release.js");
const { fetchReviewApplication } = await import("../lib/verification-api.js");
const { ContractRolesPage } = await import("./ContractRolesPage.jsx");
const { OnChainRolesPanel, VerifyReviewApplicationPage } = await import("./VerifyPages.jsx");

const ADMIN = "0x1111111111111111111111111111111111111111";
const ARTIST = "0x2222222222222222222222222222222222222222";
const REVIEWER = "0x4444444444444444444444444444444444444444";

function walletFor(account) {
  return {
    connected: true,
    authenticated: true,
    account,
    authHeaders: { authorization: "Bearer test" },
    getProvider: () => ({ request: vi.fn() }),
  };
}

function renderPanel(account) {
  return render(
    <WalletCtx.Provider value={walletFor(account)}>
      <OnChainRolesPanel artistWallet={ARTIST} />
    </WalletCtx.Provider>,
  );
}

function publishingSection() {
  return screen.getByText("On-chain publishing roles").closest("section");
}

describe("on-chain publishing role controls", () => {
  beforeEach(() => {
    readPublishingRoles.mockResolvedValue({ ARTIST_ROLE: false, ISSUER_ROLE: false });
    readFujiRole.mockImplementation(async (_provider, role, account) => role === FUJI_ROLES.DEFAULT_ADMIN_ROLE && account?.toLowerCase() === ADMIN.toLowerCase());
    grantPublishingRoles.mockResolvedValue([
      { role: "ARTIST_ROLE", hash: "0xaaa" },
      { role: "ISSUER_ROLE", hash: "0xbbb" },
    ]);
    fetchReviewApplication.mockResolvedValue({
      publicId: "app_verified",
      artistName: "Verified Artist",
      legalName: "Legal Name",
      email: "artist@example.com",
      artistType: "Musician",
      location: "New York",
      yearsActive: "5",
      artistBio: "bio",
      workDescription: "work",
      verificationEvidence: "evidence",
      status: "VERIFIED",
      walletAddress: ARTIST,
      reviewNotes: "",
      workUrls: [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("targets DEFAULT_ADMIN_ROLE on the certified Fuji release", () => {
    expect(FUJI_RELEASE_CONFIG.contractAddress).toBe("0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6");
    expect(FUJI_ROLES.DEFAULT_ADMIN_ROLE).toBe(`0x${"00".repeat(32)}`);
  });

  it("hides grant and on-chain revoke from a connected wallet that is not the contract admin", async () => {
    renderPanel(REVIEWER);
    expect(await screen.findByText(/ARTIST_ROLE/)).toBeTruthy();
    const panel = publishingSection();
    expect(within(panel).queryByRole("button", { name: /grant publishing roles/i })).toBeNull();
    expect(within(panel).queryByRole("button", { name: /revoke/i })).toBeNull();
    expect(grantPublishingRoles).not.toHaveBeenCalled();
    expect(readFujiRole).toHaveBeenCalledWith(expect.anything(), FUJI_ROLES.DEFAULT_ADMIN_ROLE, REVIEWER);
  });

  it("still lets the contract admin grant missing publishing roles", async () => {
    renderPanel(ADMIN);
    const grant = await within(publishingSection()).findByRole("button", { name: /grant publishing roles/i });
    expect(within(publishingSection()).queryByRole("button", { name: /revoke/i })).toBeNull();
    fireEvent.click(grant);
    await screen.findByText(/Roles granted on Fuji/);
    expect(grantPublishingRoles).toHaveBeenCalledWith(expect.objectContaining({ from: ADMIN, account: ARTIST }));
  });

  it("hides the grant once the artist already holds both roles, without removing the admin check", async () => {
    readPublishingRoles.mockResolvedValue({ ARTIST_ROLE: true, ISSUER_ROLE: true });
    renderPanel(ADMIN);
    expect(await screen.findByText(/ARTIST_ROLE ✓/)).toBeTruthy();
    expect(within(publishingSection()).queryByRole("button", { name: /grant publishing roles/i })).toBeNull();
    expect(within(publishingSection()).queryByRole("button", { name: /revoke/i })).toBeNull();
  });

  it("hides the grant on the contract roles page unless the connected wallet is admin", async () => {
    render(
      <WalletCtx.Provider value={walletFor(REVIEWER)}>
        <ContractRolesPage />
      </WalletCtx.Provider>,
    );
    fireEvent.change(screen.getByRole("textbox", { name: /artist wallet address/i }), { target: { value: ARTIST } });
    expect(await screen.findByText(/ARTIST_ROLE/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /grant publishing roles/i })).toBeNull();
    expect(screen.getByText(/this wallet cannot grant roles/)).toBeTruthy();
  });

  it("hides the grant on a verified application for a non-admin and keeps the verification revoke", async () => {
    render(
      <WalletCtx.Provider value={walletFor(REVIEWER)}>
        <MemoryRouter initialEntries={["/verify/review/app_verified"]}>
          <Routes>
            <Route path="/verify/review/:id" element={<VerifyReviewApplicationPage />} />
          </Routes>
        </MemoryRouter>
      </WalletCtx.Provider>,
    );
    expect(await screen.findByText(/ARTIST_ROLE/)).toBeTruthy();
    expect(within(publishingSection()).queryByRole("button", { name: /grant publishing roles/i })).toBeNull();
    expect(within(publishingSection()).queryByRole("button", { name: /revoke/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^revoke$/i })).toBeTruthy();
  });

  it("shows the grant on a verified application when the connected wallet is the contract admin", async () => {
    render(
      <WalletCtx.Provider value={walletFor(ADMIN)}>
        <MemoryRouter initialEntries={["/verify/review/app_verified"]}>
          <Routes>
            <Route path="/verify/review/:id" element={<VerifyReviewApplicationPage />} />
          </Routes>
        </MemoryRouter>
      </WalletCtx.Provider>,
    );
    expect(await screen.findByText(/ARTIST_ROLE/)).toBeTruthy();
    expect(within(publishingSection()).getByRole("button", { name: /grant publishing roles/i })).toBeTruthy();
  });
});
