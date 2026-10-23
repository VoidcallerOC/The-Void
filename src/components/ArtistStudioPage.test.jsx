/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Interface } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";
import { FUJI_RELEASE_FACTORY_V2_CONFIG } from "../lib/fuji-release.js";

const studioFetch = vi.fn();
const readReleaseAlbumState = vi.fn();
const readReleaseEdition = vi.fn();
const sendReleaseTransaction = vi.fn();
const readReleasePrimarySale = vi.fn(async () => null);
const simulateReleaseSaleConfigure = vi.fn();
const readGenesisClaimSaleGuard = vi.fn(async () => ({ state: "none" }));
const readReleaseLifecycle = vi.fn();
const real = vi.hoisted(() => ({ simulateReleaseCall: null }));
// Passes through to the real simulation except where a test overrides it.
const simulateReleaseCall = vi.fn((...args) => real.simulateReleaseCall(...args));
vi.mock("../lib/studio-api.js", async (importOriginal) => ({ ...(await importOriginal()), studioFetch: (...args) => studioFetch(...args) }));
vi.mock("../lib/fuji-release.js", async (importOriginal) => {
  const original = await importOriginal();
  real.simulateReleaseCall = original.simulateReleaseCall;
  return {
  ...original,
  simulateReleaseCall: (...args) => simulateReleaseCall(...args),
  readReleaseAlbumState: (...args) => readReleaseAlbumState(...args),
  readReleaseEdition: (...args) => readReleaseEdition(...args),
  sendReleaseTransaction: (...args) => sendReleaseTransaction(...args),
  };
});
// A recorded factory with a future version 5 whose lifecycle interface has not been reviewed.
const { FUTURE_FACTORY } = vi.hoisted(() => ({ FUTURE_FACTORY: "0x00000000000000000000000000000000000000f4" }));
vi.mock("../../config/release-network.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, releaseDeploymentForFactory: (address) => (String(address).toLowerCase() === FUTURE_FACTORY ? { factoryAddress: FUTURE_FACTORY, releaseVersion: 5, albumCapable: true, chainId: 43113 } : original.releaseDeploymentForFactory(address)) };
});
vi.mock("../lib/release-lifecycle.js", async (importOriginal) => ({ ...(await importOriginal()), readReleaseLifecycle: (...args) => readReleaseLifecycle(...args) }));
vi.mock("../lib/primary-sale.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createFujiPublicProvider: () => ({ request: vi.fn() }),
  readReleasePrimarySale: (...args) => readReleasePrimarySale(...args),
  simulateReleaseSaleConfigure: (...args) => simulateReleaseSaleConfigure(...args),
}));
const verifyReleaseSaleBinding = vi.fn(async (_provider, binding) => binding);
vi.mock("../lib/release-sale-binding.js", async (importOriginal) => ({ ...(await importOriginal()), verifyReleaseSaleBinding: (...args) => verifyReleaseSaleBinding(...args) }));
vi.mock("../lib/genesis-claim.js", async (importOriginal) => ({ ...(await importOriginal()), readGenesisClaimSaleGuard: (...args) => readGenesisClaimSaleGuard(...args) }));
const { ArtistStudioPage } = await import("./ArtistStudioPage.jsx");

const CHAIN_ID = Number(FUJI_RELEASE_FACTORY_V2_CONFIG.chainId);
const CLONE = "0x1111111111111111111111111111111111111111";
const SALE = "0x2222222222222222222222222222222222222222";
const ANCHOR = "0x3333333333333333333333333333333333333333";
const PRE_ALBUM = { supported: false, created: false, closed: false, trackCount: 0n, singleCount: 0n };
const walletProvider = { request: vi.fn() };
const wallet = { connected: true, authenticated: true, account: "0x4444444444444444444444444444444444444444", chainId: CHAIN_ID, authHeaders: { authorization: "Bearer session" }, getProvider: () => walletProvider };
const artists = [{ id: "artist-a", display_name: "Artist A", slug: "artist-a" }];

function renderStudio(releaseId) {
  return render(
    <WalletCtx.Provider value={wallet}>
      <MemoryRouter initialEntries={[`/studio?release=${releaseId}`]}>
        <ArtistStudioPage />
      </MemoryRouter>
    </WalletCtx.Provider>,
  );
}

function publishedCatalog(releaseMetadata) {
  return {
    artists,
    releases: [{ id: "rel-out", artist_id: "artist-a", title: "Out Now", status: "PUBLISHED", release_metadata: releaseMetadata }],
    editions: [{ id: "ed-out", release_id: "rel-out", title: "Track One", status: "PUBLISHED", supply: "25", chain_id: CHAIN_ID, contract_address: CLONE, token_id: "5", application_metadata: {} }],
    experiences: [],
  };
}

// A bound (provisioning CONFIRMED) but unpublished ALBUM draft.
function albumDraftCatalog({ editions = [], releaseBindings = undefined } = {}) {
  return { artists, releases: [{ id: "rel-draft", artist_id: "artist-a", title: "Album Draft", status: "DRAFT", release_metadata: { releaseType: "ALBUM" } }], editions, experiences: [], ...(releaseBindings ? { releaseBindings } : {}) };
}

const LIFECYCLE_PATH = "/studio/releases/rel-draft/lifecycle-editions";

// The release-scoped read Studio makes right before album activation: every stored token ID for the
// release and its factory bindings. `lifecycle` overrides the response (an object, or a function that
// returns one or throws); by default it is a complete response with `tokenIds` and `releaseBindings`.
function mockConfirmedAlbumDraft({ editions = [], releaseBindings = undefined, tokenIds = [], lifecycle = undefined } = {}) {
  const catalog = albumDraftCatalog({ editions, releaseBindings });
  studioFetch.mockImplementation(async (path) => {
    if (path === "/studio/catalog") return catalog;
    if (path === LIFECYCLE_PATH) {
      if (lifecycle === undefined) return { releaseId: "rel-draft", complete: true, tokenIds, releaseBindings: releaseBindings ?? [] };
      return typeof lifecycle === "function" ? lifecycle() : lifecycle;
    }
    if (path.endsWith("/provisioning/prepare")) return { state: "CONFIRMED", chainId: CHAIN_ID, releaseKey: `0x${"ab".repeat(32)}`, artistWallet: wallet.account };
    if (path.endsWith("/provisioning/status")) return { state: "CONFIRMED", chainId: CHAIN_ID, releaseContractAddress: CLONE, primarySaleAddress: SALE, provenanceAnchorAddress: ANCHOR };
    throw new Error(`unexpected ${path}`);
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const mock of [studioFetch, readReleaseAlbumState, readReleaseEdition, sendReleaseTransaction, simulateReleaseSaleConfigure]) mock.mockReset();
  readReleasePrimarySale.mockReset().mockImplementation(async () => null);
  readGenesisClaimSaleGuard.mockReset().mockImplementation(async () => ({ state: "none" }));
  readReleaseLifecycle.mockReset();
  simulateReleaseCall.mockReset();
});

describe("Artist Studio release type after reload", () => {
  it("reloads a published ALBUM release as ALBUM and reads album state from its bound contract", async () => {
    studioFetch.mockResolvedValue(publishedCatalog({ releaseType: "ALBUM" }));
    readReleaseAlbumState.mockResolvedValue(PRE_ALBUM);
    renderStudio("rel-out");
    await waitFor(() => expect(readReleaseAlbumState).toHaveBeenCalledWith(expect.anything(), CLONE));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Catalog editor workflow" })).getByRole("button", { name: /Your release/ }));
    expect(screen.getByLabelText(/Release type/).value).toBe("ALBUM");
    // A pre-album clone still fails closed.
    expect(await screen.findByText(/pre-album implementation/)).toBeTruthy();
  });

  it("keeps a legacy release with no stored type as EP and never reads album state", async () => {
    studioFetch.mockResolvedValue(publishedCatalog(null));
    renderStudio("rel-out");
    await waitFor(() => expect(studioFetch).toHaveBeenCalledWith("/studio/catalog", expect.anything()));
    fireEvent.click(within(await screen.findByRole("navigation", { name: "Catalog editor workflow" })).getByRole("button", { name: /Your release/ }));
    await waitFor(() => expect(screen.getByLabelText(/Release type/).value).toBe("EP"));
    expect(readReleaseAlbumState).not.toHaveBeenCalled();
  });

  it("reloads a bound ALBUM draft with the album panel and disables album actions on a pre-album clone", async () => {
    mockConfirmedAlbumDraft();
    readReleaseAlbumState.mockResolvedValue(PRE_ALBUM);
    renderStudio("rel-draft");
    expect(await screen.findByLabelText(/Designate this track as a Single/)).toBeTruthy();
    await waitFor(() => expect(readReleaseAlbumState).toHaveBeenCalledWith(expect.anything(), CLONE));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Catalog editor workflow" })).getByRole("button", { name: /Your release/ }));
    expect(await screen.findByText(/pre-album implementation/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Activate Album Contract" }).disabled).toBe(true);
  });

  it("clears the single flag and track mint end when starting a new track", async () => {
    mockConfirmedAlbumDraft();
    readReleaseAlbumState.mockResolvedValue({ supported: true, created: true, closed: false, trackCount: 1n, singleCount: 0n });
    renderStudio("rel-draft");
    const single = await screen.findByLabelText(/Designate this track as a Single/);
    fireEvent.click(single);
    fireEvent.change(screen.getByLabelText(/Track mint end/), { target: { value: "2026-12-01T10:00" } });
    expect(single.checked).toBe(true);
    expect(screen.getByLabelText(/Track mint end/).value).toBe("2026-12-01T10:00");

    fireEvent.click(screen.getByText("Add tracks", { selector: "h2" }).closest("button"));
    fireEvent.change(screen.getByLabelText(/Select album \/ collection/), { target: { value: "rel-draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Add track" }));

    expect((await screen.findByLabelText(/Designate this track as a Single/)).checked).toBe(false);
    expect(screen.getByLabelText(/Track mint end/).value).toBe("");
  });
});

describe("Artist Studio standalone singles", () => {
  it("offers Single, EP and Album and reloads a published SINGLE as SINGLE without reading album state", async () => {
    studioFetch.mockResolvedValue(publishedCatalog({ releaseType: "SINGLE" }));
    renderStudio("rel-out");
    await waitFor(() => expect(studioFetch).toHaveBeenCalledWith("/studio/catalog", expect.anything()));
    fireEvent.click(within(await screen.findByRole("navigation", { name: "Catalog editor workflow" })).getByRole("button", { name: /Your release/ }));
    const type = screen.getByLabelText(/Release type/);
    await waitFor(() => expect(type.value).toBe("SINGLE"));
    expect([...type.querySelectorAll("option")].map((option) => option.value)).toEqual(["SINGLE", "EP", "ALBUM"]);
    expect(readReleaseAlbumState).not.toHaveBeenCalled();
  });

  it("does not offer a second track on a published single", async () => {
    studioFetch.mockResolvedValue(publishedCatalog({ releaseType: "SINGLE" }));
    renderStudio("rel-out");
    await waitFor(() => expect(studioFetch).toHaveBeenCalledWith("/studio/catalog", expect.anything()));
    fireEvent.click((await screen.findByText("Add tracks", { selector: "h2" })).closest("button"));
    fireEvent.change(screen.getByLabelText(/Select album \/ collection/), { target: { value: "rel-out" } });
    const button = await screen.findByRole("button", { name: "Single already has its track" });
    expect(button.disabled).toBe(true);
  });

  it("adds a released single to an album draft at a track position without re-creating the single", async () => {
    const catalog = {
      artists,
      releases: [
        { id: "rel-draft", artist_id: "artist-a", title: "Album Draft", status: "DRAFT", release_metadata: { releaseType: "ALBUM" } },
        { id: "rel-single", artist_id: "artist-a", title: "Lead Single", status: "PUBLISHED", release_metadata: { releaseType: "SINGLE" } },
        { id: "rel-ep", artist_id: "artist-a", title: "Some EP", status: "PUBLISHED", release_metadata: { releaseType: "EP" } },
      ],
      editions: [{ id: "ed-single", release_id: "rel-single", title: "Lead Single", status: "PUBLISHED", supply: "10", chain_id: CHAIN_ID, contract_address: "0x5555555555555555555555555555555555555555", token_id: "9", application_metadata: {} }],
      experiences: [],
      albumSingles: [],
    };
    const calls = [];
    studioFetch.mockImplementation(async (path, options = {}) => {
      calls.push({ path, ...options });
      if (path === "/studio/catalog") return catalog;
      if (path.endsWith("/provisioning/prepare")) return { state: "CONFIRMED", chainId: CHAIN_ID, releaseKey: `0x${"ab".repeat(32)}`, artistWallet: wallet.account };
      if (path.endsWith("/provisioning/status")) return { state: "CONFIRMED", chainId: CHAIN_ID, releaseContractAddress: CLONE, primarySaleAddress: SALE, provenanceAnchorAddress: ANCHOR };
      if (path === "/studio/releases/rel-draft/album-singles") return { albumReleaseId: "rel-draft", singleReleaseId: "rel-single", singleEditionId: "ed-single", trackPosition: 3 };
      throw new Error(`unexpected ${path}`);
    });
    readReleaseAlbumState.mockResolvedValue(PRE_ALBUM);
    renderStudio("rel-draft");
    await waitFor(() => expect(studioFetch).toHaveBeenCalledWith("/studio/catalog", expect.anything()));
    fireEvent.click(within(await screen.findByRole("navigation", { name: "Catalog editor workflow" })).getByRole("button", { name: /Your release/ }));
    const choice = await screen.findByLabelText(/^Single/);
    // Only the artist's published singles are offered, never an EP.
    expect([...choice.querySelectorAll("option")].map((option) => option.value)).toEqual(["", "rel-single"]);
    fireEvent.change(choice, { target: { value: "rel-single" } });
    fireEvent.change(await screen.findByLabelText(/Track position/), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Add single to album" }));
    expect(await screen.findByText("Lead Single · track 3")).toBeTruthy();
    const post = calls.find((call) => call.path === "/studio/releases/rel-draft/album-singles");
    expect(post).toMatchObject({ method: "POST", payload: { singleReleaseId: "rel-single", trackPosition: 3 } });
    // Nothing re-creates or edits the single release or its edition.
    expect(calls.some((call) => /rel-single|ed-single/.test(call.path))).toBe(false);
  });
});

// Fuji, 2026-10-10: forgive-forget-28 was configured for 18:45-18:50 UTC (5 minutes),
// closed with 0 sold, and Studio could not reopen it.
const NOW = Date.UTC(2026, 9, 10, 19, 29, 0);
const NOW_SEC = BigInt(NOW / 1000);
const TOKEN = "5";
const saleIface = new Interface(["function configureSale(uint256 tokenId, uint256 priceWei, uint256 maxSupply, uint256 perWalletLimit, uint64 startTime, uint64 endTime, bool paused)"]);

function localInput(seconds) {
  const date = new Date(Number(seconds) * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function chainSale(overrides = {}) {
  return {
    priceWei: 10_000_000_000_000_000n,
    maxSupply: 0n,
    sold: 0n,
    perWalletLimit: 1n,
    startTime: BigInt(Date.UTC(2026, 9, 10, 18, 45) / 1000),
    endTime: BigInt(Date.UTC(2026, 9, 10, 18, 50) / 1000),
    paused: false,
    configured: true,
    purchased: 0n,
    remaining: null,
    ...overrides,
  };
}

function renderSaleStep({ sale = chainSale(), editionSupply = 0n, claim = { state: "none" } } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const catalog = publishedCatalog({ releaseType: "SINGLE" });
  catalog.editions[0].primary_sale_address = SALE;
  catalog.editions[0].token_id = TOKEN;
  studioFetch.mockResolvedValue(catalog);
  readReleasePrimarySale.mockResolvedValue(sale);
  readReleaseEdition.mockResolvedValue({ exists: true, artist: wallet.account, maxSupply: editionSupply, mintedSupply: sale?.sold ?? 0n });
  readGenesisClaimSaleGuard.mockResolvedValue(claim);
  simulateReleaseSaleConfigure.mockResolvedValue("0x");
  sendReleaseTransaction.mockResolvedValue({ hash: `0x${"cd".repeat(32)}`, receipt: { status: "0x1" } });
  return renderStudio("rel-out");
}

function decodeSent() {
  expect(sendReleaseTransaction).toHaveBeenCalledTimes(1);
  const [{ data, to, from }] = sendReleaseTransaction.mock.calls[0];
  expect(to).toBe(SALE);
  expect(from).toBe(wallet.account);
  return saleIface.decodeFunctionData("configureSale", data);
}

function problems() {
  return screen.getByRole("alert", { name: "Sale problems" }).textContent;
}

describe("Artist Studio sale resolution from the published catalog", () => {
  const BLOCKER = /no confirmed, dedicated primary sale/;
  beforeEach(() => verifyReleaseSaleBinding.mockClear());
  const FACTORY = "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8";
  const binding = (overrides = {}) => ({ release_id: "rel-out", chain_id: CHAIN_ID, release_contract_address: CLONE, primary_sale_address: SALE, factory_address: FACTORY, artist_wallet: wallet.account, ...overrides });
  // The edition row carries no sale address, exactly as /studio/catalog returned it before the fix.
  function renderResumed({ releaseBindings, editionOverrides = {} } = {}) {
    const catalog = { ...publishedCatalog({ releaseType: "SINGLE" }), ...(releaseBindings ? { releaseBindings } : {}) };
    Object.assign(catalog.editions[0], editionOverrides);
    studioFetch.mockResolvedValue(catalog);
    readReleasePrimarySale.mockResolvedValue({ configured: false, priceWei: 0n, maxSupply: 0n, sold: 0n, perWalletLimit: 0n, startTime: 0n, endTime: 0n, paused: false, purchased: 0n, remaining: null });
    readReleaseEdition.mockResolvedValue({ exists: true, artist: wallet.account, maxSupply: 0n, mintedSupply: 0n });
    return renderStudio("rel-out");
  }

  it("offers the sale form when the release binding is chain-verified", async () => {
    renderResumed({ releaseBindings: [binding()] });
    expect(await screen.findByText(/This is the public sale/)).toBeTruthy();
    expect(screen.queryByText(BLOCKER)).toBeNull();
    expect(verifyReleaseSaleBinding).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ releaseContractAddress: CLONE, primarySaleAddress: SALE, factoryAddress: FACTORY, chainId: CHAIN_ID }));
  });

  it("uses the edition's own sale address when the catalog supplies it", async () => {
    renderResumed({ editionOverrides: { primary_sale_address: SALE, factory_address: FACTORY } });
    expect(await screen.findByText(/This is the public sale/)).toBeTruthy();
  });

  it("stays blocked when no binding names a sale", async () => {
    renderResumed();
    expect(await screen.findByText(BLOCKER)).toBeTruthy();
    expect(verifyReleaseSaleBinding).not.toHaveBeenCalled();
  });

  it("stays blocked when the only binding names a different clone", async () => {
    renderResumed({ releaseBindings: [binding({ release_contract_address: "0x9999999999999999999999999999999999999999" })] });
    expect(await screen.findByText(BLOCKER)).toBeTruthy();
    expect(verifyReleaseSaleBinding).not.toHaveBeenCalled();
  });

  it("stays blocked when the chain check rejects the binding", async () => {
    verifyReleaseSaleBinding.mockRejectedValueOnce(new Error("The sale contract does not belong to this release."));
    renderResumed({ releaseBindings: [binding()] });
    expect(await screen.findByText(BLOCKER)).toBeTruthy();
    expect(await screen.findByText(/could not be verified on-chain/)).toBeTruthy();
    expect(screen.queryByText(/This is the public sale/)).toBeNull();
  });
});

describe("Artist Studio live primary sale", () => {
  it("shows the configured on-chain sale with local and UTC times and its status", async () => {
    renderSaleStep({ sale: chainSale({ sold: 2n, perWalletLimit: 3n }) });
    const panel = await screen.findByRole("status", { name: "Live sale" });
    expect(panel.textContent).toContain("Live sale · Ended");
    expect(panel.textContent).toContain("0.01 AVAX");
    expect(panel.textContent).toMatch(/CapNo cap/);
    expect(panel.textContent).toMatch(/Sold2/);
    expect(panel.textContent).toMatch(/Per wallet3/);
    expect(panel.textContent).toContain("18:45 UTC");
    expect(panel.textContent).toContain("18:50 UTC");
    expect(panel.textContent).toContain("your time");
    expect(panel.textContent).toMatch(/PausedNo/);
    expect(screen.getByRole("button", { name: "Edit sale" }).disabled).toBe(false);
    expect(readReleasePrimarySale).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ primarySaleAddress: SALE, releaseContractAddress: CLONE, tokenId: TOKEN }), wallet.account);
  });

  it("reopens an ended sale: one configureSale with the new values, after simulation", async () => {
    renderSaleStep();
    fireEvent.click(await screen.findByRole("button", { name: "Edit sale" }));
    expect(screen.getByLabelText(/Price \(AVAX\)/).value).toBe("0.01");
    expect(screen.getByLabelText(/Sale end/).value).toBe(localInput(Date.UTC(2026, 9, 10, 18, 50) / 1000));
    fireEvent.change(screen.getByLabelText(/Sale start/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "1 hour" }));
    const end = NOW_SEC + 3600n;
    expect(screen.getByLabelText(/Sale end/).value).toBe(localInput(end));
    fireEvent.click(screen.getByRole("button", { name: "Review sale" }));

    const confirm = await screen.findByRole("dialog", { name: "Confirm sale change" });
    expect(confirm.textContent).toContain("Sale runs for 1 hour");
    expect(confirm.textContent).toContain("your time");
    expect(confirm.textContent).toContain("20:29 UTC");
    expect(sendReleaseTransaction).not.toHaveBeenCalled();
    expect(simulateReleaseSaleConfigure).not.toHaveBeenCalled();

    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm and sign" }));
    await waitFor(() => expect(sendReleaseTransaction).toHaveBeenCalled());
    const [tokenId, priceWei, maxSupply, perWalletLimit, startTime, endTime, paused] = decodeSent();
    expect({ tokenId, priceWei, maxSupply, perWalletLimit, startTime, endTime, paused }).toEqual({ tokenId: 5n, priceWei: 10_000_000_000_000_000n, maxSupply: 0n, perWalletLimit: 1n, startTime: 0n, endTime: end, paused: false });
    expect(simulateReleaseSaleConfigure).toHaveBeenCalledTimes(1);
    expect(simulateReleaseSaleConfigure.mock.calls[0][1]).toMatchObject({ from: wallet.account, to: SALE, data: sendReleaseTransaction.mock.calls[0][0].data });
    expect(simulateReleaseSaleConfigure.mock.invocationCallOrder[0]).toBeLessThan(sendReleaseTransaction.mock.invocationCallOrder[0]);
  });

  it("configures the unconfigured open edition with a second-precision T+300 → T+899 window, once", async () => {
    renderSaleStep({ sale: null });
    const T = NOW_SEC + 3600n + 1n; // not minute aligned
    const stamp = (seconds) => {
      const date = new Date(Number(seconds) * 1000);
      const pad = (value) => String(value).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };
    expect((await screen.findByLabelText(/Sale start/)).getAttribute("step")).toBe("1");
    expect(screen.getByLabelText(/Sale end/).getAttribute("step")).toBe("1");
    fireEvent.change(screen.getByLabelText(/Most one person can buy/), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(/Sale start/), { target: { value: stamp(T + 300n) } });
    fireEvent.change(screen.getByLabelText(/Sale end/), { target: { value: stamp(T + 899n) } });
    fireEvent.click(screen.getByRole("button", { name: "Review sale" }));
    const confirm = await screen.findByRole("dialog", { name: "Confirm sale change" });
    expect(confirm.textContent).toContain("Sale runs for 9 minutes 59 seconds");
    const button = within(confirm).getByRole("button", { name: "Confirm and sign" });
    fireEvent.click(button);
    fireEvent.click(button); // double click must not submit twice
    await waitFor(() => expect(sendReleaseTransaction).toHaveBeenCalled());
    const [tokenId, priceWei, maxSupply, perWalletLimit, startTime, endTime, paused] = decodeSent();
    expect({ tokenId, priceWei, maxSupply, perWalletLimit, startTime, endTime, paused }).toEqual({ tokenId: 5n, priceWei: 10_000_000_000_000_000n, maxSupply: 0n, perWalletLimit: 0n, startTime: T + 300n, endTime: T + 899n, paused: false });
    expect(simulateReleaseSaleConfigure).toHaveBeenCalledTimes(1);
  });

  it("warns about a short window before signing", async () => {
    renderSaleStep();
    fireEvent.click(await screen.findByRole("button", { name: "Edit sale" }));
    fireEvent.change(screen.getByLabelText(/Sale start/), { target: { value: localInput(NOW_SEC + 600n) } });
    fireEvent.change(screen.getByLabelText(/Sale end/), { target: { value: localInput(NOW_SEC + 900n) } });
    fireEvent.click(screen.getByRole("button", { name: "Review sale" }));
    const confirm = await screen.findByRole("dialog", { name: "Confirm sale change" });
    expect(confirm.textContent).toContain("Sale runs for 5 minutes");
    expect(confirm.textContent).toContain("Short window: the sale is open for only 5 minutes.");
  });

  it("rejects an open edition without an end time", async () => {
    renderSaleStep();
    fireEvent.click(await screen.findByRole("button", { name: "Edit sale" }));
    fireEvent.change(screen.getByLabelText(/Sale end/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Review sale" }));
    expect(problems()).toContain("An open edition needs an end time");
    expect(screen.queryByRole("dialog", { name: "Confirm sale change" })).toBeNull();
    expect(simulateReleaseSaleConfigure).not.toHaveBeenCalled();
    expect(sendReleaseTransaction).not.toHaveBeenCalled();
  });

  it("rejects a cap below the copies already sold", async () => {
    renderSaleStep({ sale: chainSale({ maxSupply: 10n, sold: 3n, remaining: 7n }), editionSupply: 25n });
    fireEvent.click(await screen.findByRole("button", { name: "Edit sale" }));
    fireEvent.change(screen.getByLabelText(/^Sale cap/), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/Most one person can buy/), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/Sale end/), { target: { value: localInput(NOW_SEC + 86_400n) } });
    fireEvent.click(screen.getByRole("button", { name: "Review sale" }));
    expect(problems()).toContain("can't be lower than the 3 already sold");
    expect(sendReleaseTransaction).not.toHaveBeenCalled();
  });

  it("rejects an end time at or before the start", async () => {
    renderSaleStep();
    fireEvent.click(await screen.findByRole("button", { name: "Edit sale" }));
    const at = localInput(NOW_SEC + 7200n);
    fireEvent.change(screen.getByLabelText(/Sale start/), { target: { value: at } });
    fireEvent.change(screen.getByLabelText(/Sale end/), { target: { value: at } });
    fireEvent.click(screen.getByRole("button", { name: "Review sale" }));
    expect(problems()).toContain("The end time must be after the start time.");
    expect(sendReleaseTransaction).not.toHaveBeenCalled();
  });

  it("duration presets set the end from the start time, or from now", async () => {
    renderSaleStep();
    fireEvent.click(await screen.findByRole("button", { name: "Edit sale" }));
    const start = NOW_SEC + 3600n;
    fireEvent.change(screen.getByLabelText(/Sale start/), { target: { value: localInput(start) } });
    fireEvent.click(screen.getByRole("button", { name: "24 hours" }));
    expect(screen.getByLabelText(/Sale end/).value).toBe(localInput(start + 86_400n));
    fireEvent.click(screen.getByRole("button", { name: "5 days" }));
    expect(screen.getByLabelText(/Sale end/).value).toBe(localInput(start + 432_000n));
    fireEvent.change(screen.getByLabelText(/Sale start/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "1 hour" }));
    expect(screen.getByLabelText(/Sale end/).value).toBe(localInput(NOW_SEC + 3600n));
  });

  it("pauses through the same configureSale path, keeping every other value", async () => {
    const sale = chainSale({ startTime: 0n, endTime: NOW_SEC + 3601n });
    renderSaleStep({ sale });
    fireEvent.click(await screen.findByRole("button", { name: "Pause sale" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Confirm sale change" })).getByRole("button", { name: "Confirm and sign" }));
    await waitFor(() => expect(sendReleaseTransaction).toHaveBeenCalled());
    const [, priceWei, maxSupply, perWalletLimit, startTime, endTime, paused] = decodeSent();
    expect({ priceWei, maxSupply, perWalletLimit, startTime, endTime, paused }).toEqual({ priceWei: sale.priceWei, maxSupply: 0n, perWalletLimit: 1n, startTime: 0n, endTime: NOW_SEC + 3601n, paused: true });
    expect(simulateReleaseSaleConfigure).toHaveBeenCalledTimes(1);
  });

  it("warns about a Genesis holder claim and blocks edits that break its invariants", async () => {
    const claimStart = NOW_SEC - 3600n;
    const claimEnd = claimStart + 86_400n;
    const publicSaleStart = claimStart; // the paid mint opens together with the claims
    const publicSaleEnd = claimStart + 7n * 86_400n - 1n;
    const sale = chainSale({ maxSupply: 20n, startTime: publicSaleStart, endTime: publicSaleEnd, remaining: 20n });
    const claim = { state: "active", claimContract: "0x6666666666666666666666666666666666666666", allocation: 5n, publicAllocation: 20n, claimStart, claimEnd, publicSaleStart, publicSaleEnd, publicPriceWei: sale.priceWei, claimedSupply: 1n, live: true };
    renderSaleStep({ sale, editionSupply: 25n, claim });
    const warning = await screen.findByText(/Genesis holder claim is configured for this token/);
    expect(warning.closest("[role=alert]").textContent).toContain("The sale cap must stay 20");

    fireEvent.click(screen.getByRole("button", { name: "Edit sale" }));
    fireEvent.change(screen.getByLabelText(/^Sale cap/), { target: { value: "21" } });
    fireEvent.click(screen.getByRole("button", { name: "Review sale" }));
    expect(problems()).toContain("The sale cap must stay 20");

    fireEvent.change(screen.getByLabelText(/^Sale cap/), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText(/Sale start/), { target: { value: localInput(NOW_SEC + 600n) } });
    fireEvent.click(screen.getByRole("button", { name: "Review sale" }));
    expect(problems()).toContain("Genesis holder claims are still open");
    expect(screen.queryByRole("dialog", { name: "Confirm sale change" })).toBeNull();
    expect(simulateReleaseSaleConfigure).not.toHaveBeenCalled();
    expect(sendReleaseTransaction).not.toHaveBeenCalled();
  });
});

describe("Artist Studio album activation lifecycle (D3)", () => {
  const ALBUM_READY = { supported: true, created: false, closed: false, trackCount: 0n, singleCount: 0n };
  const V4_FACTORY = "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8";
  const V4_EXPECT = { albumCreated: true, hasStandaloneEditions: false };
  const binding = { release_id: "rel-draft", chain_id: CHAIN_ID, release_contract_address: CLONE, primary_sale_address: SALE, factory_address: V4_FACTORY, artist_wallet: wallet.account };
  const MINED_TOKEN = "25679935302133066722236771263728427871936411831072189551573738559199048803312";
  // Prepared and mined under its first title, confirmation never completed, then renamed as a draft.
  const renamedDraft = { id: "ed-draft", release_id: "rel-draft", title: "Renamed Draft", status: "DRAFT", supply: "10", application_metadata: {} };
  const lifecycleCalls = () => studioFetch.mock.calls.filter(([path]) => path === LIFECYCLE_PATH).length;
  const catalogCalls = () => studioFetch.mock.calls.filter(([path]) => path === "/studio/catalog").length;

  async function clickActivate() {
    renderStudio("rel-draft");
    await waitFor(() => expect(readReleaseAlbumState).toHaveBeenCalledWith(expect.anything(), CLONE));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Catalog editor workflow" })).getByRole("button", { name: /Your release/ }));
    const activate = await screen.findByRole("button", { name: "Activate Album Contract" });
    await waitFor(() => expect(activate.disabled).toBe(false));
    fireEvent.click(activate);
  }

  it("refuses to activate an album when the stored token of a renamed draft is mined, before any wallet prompt", async () => {
    mockConfirmedAlbumDraft({ editions: [renamedDraft], releaseBindings: [binding], tokenIds: [MINED_TOKEN] });
    readReleaseAlbumState.mockResolvedValue(ALBUM_READY);
    readReleaseLifecycle.mockResolvedValue({ albumCreated: false, standaloneFlag: null, existingTokenIds: [BigInt(MINED_TOKEN)], hasEditions: true });
    await clickActivate();
    expect(await screen.findByText(/cannot become an Album Contract/)).toBeTruthy();
    // The canonical stored token ID is checked, not an ID re-derived from the new title.
    expect(readReleaseLifecycle).toHaveBeenCalledWith(expect.any(Function), CLONE, { tokenIds: [BigInt(MINED_TOKEN)], expect: V4_EXPECT });
    expect(simulateReleaseCall).not.toHaveBeenCalled();
    expect(sendReleaseTransaction).not.toHaveBeenCalled();
  });

  it("refuses activation without a wallet prompt when the chain read fails", async () => {
    mockConfirmedAlbumDraft({ editions: [renamedDraft], releaseBindings: [binding], tokenIds: [MINED_TOKEN] });
    readReleaseAlbumState.mockResolvedValue(ALBUM_READY);
    readReleaseLifecycle.mockRejectedValue(new Error("Fuji RPC unavailable"));
    await clickActivate();
    expect(await screen.findByText(/Fuji RPC unavailable/)).toBeTruthy();
    expect(simulateReleaseCall).not.toHaveBeenCalled();
    expect(sendReleaseTransaction).not.toHaveBeenCalled();
  });

  for (const [label, setup] of [
    ["the binding's factory is not a recorded deployment", () => ({ editions: [renamedDraft], releaseBindings: [{ ...binding, factory_address: "0x00000000000000000000000000000000000000aa" }], tokenIds: [MINED_TOKEN] })],
    ["the release has no binding", () => ({ editions: [renamedDraft], tokenIds: [MINED_TOKEN] })],
    ["the recorded factory's version is not a reviewed lifecycle implementation", () => ({ editions: [renamedDraft], releaseBindings: [{ ...binding, factory_address: FUTURE_FACTORY }], tokenIds: [MINED_TOKEN] })],
  ]) {
    it(`refuses activation before reading the chain when ${label}`, async () => {
      mockConfirmedAlbumDraft(setup());
      readReleaseAlbumState.mockResolvedValue(ALBUM_READY);
      await clickActivate();
      expect(await screen.findByText(/could not be read, so nothing was changed/)).toBeTruthy();
      expect(readReleaseLifecycle).not.toHaveBeenCalled();
      expect(sendReleaseTransaction).not.toHaveBeenCalled();
    });
  }

  it("refuses activation on a release contract from the pre-album factory even if the album read says supported", async () => {
    mockConfirmedAlbumDraft({ releaseBindings: [{ ...binding, factory_address: "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505" }] });
    readReleaseAlbumState.mockResolvedValue(ALBUM_READY);
    readReleaseLifecycle.mockResolvedValue({ albumCapable: false, albumCreated: false, standaloneFlag: null, existingTokenIds: [], hasEditions: false });
    await clickActivate();
    expect(await screen.findByText(/can never become an Album Contract/)).toBeTruthy();
    expect(readReleaseLifecycle).toHaveBeenCalledWith(expect.any(Function), CLONE, { tokenIds: [], expect: { albumCreated: false, hasStandaloneEditions: false } });
    expect(simulateReleaseCall).not.toHaveBeenCalled();
    expect(sendReleaseTransaction).not.toHaveBeenCalled();
  });

  it("activates the album when the complete release-scoped read has no editions", async () => {
    mockConfirmedAlbumDraft({ releaseBindings: [binding], tokenIds: [] });
    readReleaseAlbumState.mockResolvedValue(ALBUM_READY);
    readReleaseLifecycle.mockResolvedValue({ albumCapable: true, albumCreated: false, standaloneFlag: null, existingTokenIds: [], hasEditions: false });
    simulateReleaseCall.mockResolvedValue(undefined);
    sendReleaseTransaction.mockResolvedValue({ hash: `0x${"cd".repeat(32)}` });
    await clickActivate();
    await waitFor(() => expect(sendReleaseTransaction).toHaveBeenCalledWith(expect.objectContaining({ to: CLONE, data: new Interface(["function createAlbum(bytes32)"]).encodeFunctionData("createAlbum", [`0x${"ab".repeat(32)}`]) })));
    expect(readReleaseLifecycle).toHaveBeenCalledWith(expect.any(Function), CLONE, { tokenIds: [], expect: V4_EXPECT });
    expect(lifecycleCalls()).toBe(1);
    // D2 Option A: 13 / 4 are defaults, not maximums.
    expect(await screen.findByText(/By default it holds 13 tracks, up to 4 of them singles; the release admin can approve higher limits/)).toBeTruthy();
  });

  describe("re-reads the release's editions from the release-scoped server read before deciding", () => {
    const NEW_TOKEN = "11111111111111111111111111111111111111111111111111111111111111111111";
    const OLD_TOKEN = "22222222222222222222222222222222222222222222222222222222222222222222";
    // A fake chain: an edition exists on-chain only if its token ID was minted.
    function chainWithMinted(...minted) {
      readReleaseLifecycle.mockImplementation(async (_request, _address, { tokenIds }) => {
        const existing = tokenIds.filter((tokenId) => minted.includes(String(tokenId)));
        return { albumCapable: true, albumCreated: false, standaloneFlag: null, existingTokenIds: existing, hasEditions: existing.length > 0 };
      });
    }

    it("refuses when the release's only edition is older than the owner's newest 500 catalog editions", async () => {
      // The owner-wide catalog holds the newest 500 editions, all from other releases, so this
      // release's old mined standalone edition is not in it. The release-scoped read still returns it.
      const newer = Array.from({ length: 500 }, (_, index) => ({ id: `ed-other-${index}`, release_id: "rel-other", title: `Other ${index}`, status: "PUBLISHED", supply: "1", application_metadata: {} }));
      mockConfirmedAlbumDraft({ editions: newer, releaseBindings: [binding], tokenIds: [OLD_TOKEN] });
      readReleaseAlbumState.mockResolvedValue(ALBUM_READY);
      chainWithMinted(OLD_TOKEN);
      await clickActivate();
      expect(await screen.findByText(/cannot become an Album Contract/)).toBeTruthy();
      expect(readReleaseLifecycle).toHaveBeenCalledWith(expect.any(Function), CLONE, { tokenIds: [BigInt(OLD_TOKEN)], expect: V4_EXPECT });
      expect(simulateReleaseCall).not.toHaveBeenCalled();
      expect(sendReleaseTransaction).not.toHaveBeenCalled();
    });

    it("refuses when an edition was created and mined after the page loaded", async () => {
      // Page load: no editions. Later: an edition is created, prepared (token stored) and mined.
      mockConfirmedAlbumDraft({ releaseBindings: [binding], tokenIds: [NEW_TOKEN] });
      readReleaseAlbumState.mockResolvedValue(ALBUM_READY);
      chainWithMinted(NEW_TOKEN);
      await clickActivate();
      expect(await screen.findByText(/cannot become an Album Contract/)).toBeTruthy();
      // The decision comes from the release-scoped read, never from the page-load catalog.
      expect(lifecycleCalls()).toBe(1);
      expect(catalogCalls()).toBe(1);
      expect(readReleaseLifecycle).toHaveBeenCalledWith(expect.any(Function), CLONE, { tokenIds: [BigInt(NEW_TOKEN)], expect: V4_EXPECT });
      expect(simulateReleaseCall).not.toHaveBeenCalled();
      expect(sendReleaseTransaction).not.toHaveBeenCalled();
    });

    it("checks the token stored for a draft renamed and republished after the page loaded", async () => {
      // Page load: one draft under its first title. Later: renamed, prepared again under the new title
      // (a new token stored) and published; that new token is the one on-chain.
      const initial = { id: "ed-1", release_id: "rel-draft", title: "First Title", status: "DRAFT", supply: "10", application_metadata: {} };
      mockConfirmedAlbumDraft({ editions: [initial], releaseBindings: [binding], tokenIds: [MINED_TOKEN, NEW_TOKEN] });
      readReleaseAlbumState.mockResolvedValue(ALBUM_READY);
      chainWithMinted(NEW_TOKEN);
      await clickActivate();
      expect(await screen.findByText(/cannot become an Album Contract/)).toBeTruthy();
      expect(readReleaseLifecycle).toHaveBeenCalledWith(expect.any(Function), CLONE, { tokenIds: [BigInt(MINED_TOKEN), BigInt(NEW_TOKEN)], expect: V4_EXPECT });
      expect(sendReleaseTransaction).not.toHaveBeenCalled();
    });

    const complete = { releaseId: "rel-draft", complete: true, tokenIds: [], releaseBindings: [binding] };
    for (const [label, lifecycle] of [
      ["the read fails (database or server error)", () => { throw Object.assign(new Error("Artist Studio request failed (500)."), { status: 500 }); }],
      ["the server refuses the release as not the wallet's", () => { throw Object.assign(new Error("The authenticated wallet cannot manage this release."), { status: 403, code: "ARTIST_ACCESS_DENIED" }); }],
      ["the read returns nothing", null],
      ["the read is for another release", { ...complete, releaseId: "rel-other" }],
      ["the read is not marked complete", { ...complete, complete: undefined }],
      ["the read has no token ID list", { ...complete, tokenIds: undefined }],
      ["the read has no binding list", { ...complete, releaseBindings: undefined }],
      ["the read has no binding for this contract", { ...complete, releaseBindings: [{ ...binding, release_contract_address: SALE }] }],
      ["the read binds this contract to two factories", { ...complete, releaseBindings: [binding, { ...binding, factory_address: "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505" }] }],
      ["the read has an unusable token ID", { ...complete, tokenIds: ["0xabc"] }],
    ]) {
      it(`refuses before any chain read or wallet prompt when ${label}`, async () => {
        mockConfirmedAlbumDraft({ releaseBindings: [binding], lifecycle });
        readReleaseAlbumState.mockResolvedValue(ALBUM_READY);
        chainWithMinted();
        await clickActivate();
        expect(await screen.findByText(/current editions could not be read, so nothing was changed/)).toBeTruthy();
        expect(readReleaseLifecycle).not.toHaveBeenCalled();
        expect(simulateReleaseCall).not.toHaveBeenCalled();
        expect(sendReleaseTransaction).not.toHaveBeenCalled();
      });
    }

    it("activates when the release's stored editions are not on-chain", async () => {
      mockConfirmedAlbumDraft({ releaseBindings: [binding], tokenIds: [NEW_TOKEN] });
      readReleaseAlbumState.mockResolvedValue(ALBUM_READY);
      chainWithMinted();
      simulateReleaseCall.mockResolvedValue(undefined);
      sendReleaseTransaction.mockResolvedValue({ hash: `0x${"cd".repeat(32)}` });
      await clickActivate();
      await waitFor(() => expect(sendReleaseTransaction).toHaveBeenCalledTimes(1));
      expect(lifecycleCalls()).toBe(1);
      expect(readReleaseLifecycle).toHaveBeenCalledWith(expect.any(Function), CLONE, { tokenIds: [BigInt(NEW_TOKEN)], expect: V4_EXPECT });
    });
  });
});

describe("Artist Studio on-chain tag on an existing draft", () => {
  // Deployment is switched on only inside this block; production leaves it off by default.
  beforeEach(() => vi.stubEnv("VITE_STUDIO_ONCHAIN_DEPLOY", "true"));
  afterEach(() => vi.unstubAllEnvs());
  const DIGEST_A = `0x${"aa".repeat(32)}`;
  const DIGEST_B = `0x${"bb".repeat(32)}`;
  const draftCatalog = (contractSymbol) => ({ artists, releases: [{ id: "rel-draft", artist_id: "artist-a", title: "Forgive & Forget", status: "DRAFT", release_metadata: { releaseType: "SINGLE", ...(contractSymbol ? { contractSymbol } : {}) } }], editions: [], experiences: [] });
  const prepared = (symbol, digest = DIGEST_A) => ({ state: "PENDING", requestId: "req-1", chainId: CHAIN_ID, name: "Forgive & Forget", symbol, authorizationDigest: digest, releaseKey: `0x${"ab".repeat(32)}`, artistWallet: wallet.account });
  const calls = (method, suffix) => studioFetch.mock.calls.filter(([path, options]) => (options?.method || "GET") === method && path.endsWith(suffix));
  const tagField = () => screen.findByLabelText(/On-chain tag/);

  function mockDraft({ stored, symbol = "FORGIVEFORG", status = { state: "NOT_STARTED" }, onPrepare } = {}) {
    let prepares = 0;
    studioFetch.mockImplementation(async (path, options = {}) => {
      if (path === "/studio/catalog") return draftCatalog(stored);
      if (path.endsWith("/provisioning/prepare")) { prepares += 1; return onPrepare ? onPrepare(prepares) : prepared(symbol); }
      if (path.endsWith("/provisioning/status")) return status;
      if (path === "/studio/releases/rel-draft" && options.method === "PATCH") return { id: "rel-draft" };
      throw new Error(`unexpected ${options.method || "GET"} ${path}`);
    });
  }

  const preparedPanel = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Prepare deployment" }));
    await screen.findByRole("button", { name: "Refresh deployment" });
  };
  const acknowledge = async () => fireEvent.click(await screen.findByRole("checkbox", { name: /permanent contract/i }));

  it("shows an editable on-chain tag for a loaded, undeployed draft and prepares nothing just by opening it", async () => {
    mockDraft();
    renderStudio("rel-draft");
    const field = await tagField();
    await waitFor(() => expect(calls("POST", "/provisioning/status")).toHaveLength(1));
    expect(field.readOnly).toBe(false);
    expect(field.value).toBe("");
    expect(screen.getByLabelText(/Release type/).value).toBe("SINGLE");
    expect(calls("POST", "/provisioning/prepare")).toHaveLength(0);
    expect(walletProvider.request).not.toHaveBeenCalled();
  });

  it("prefers the symbol the artist already stored on the draft", async () => {
    mockDraft({ stored: "FNF", symbol: "FNF" });
    renderStudio("rel-draft");
    await waitFor(async () => expect((await tagField()).value).toBe("FNF"));
  });

  it("normalises typing to at most 11 uppercase letters or digits", async () => {
    mockDraft();
    renderStudio("rel-draft");
    const field = await tagField();
    fireEvent.change(field, { target: { value: "fnf-12 abcdefghij" } });
    expect(field.value).toBe("FNF12ABCDEF");
  });

  it("saves an edited symbol onto the existing draft (PATCH) and prepares it, never creating a draft", async () => {
    mockDraft({ onPrepare: () => prepared("FNF", DIGEST_B) });
    renderStudio("rel-draft");
    const field = await tagField();
    fireEvent.change(field, { target: { value: "fnf" } });
    fireEvent.click(await screen.findByRole("button", { name: "Prepare deployment" }));
    await waitFor(() => expect(calls("PATCH", "/studio/releases/rel-draft")).toHaveLength(1));
    expect(calls("PATCH", "/studio/releases/rel-draft")[0][1].payload).toMatchObject({ symbol: "FNF", releaseType: "SINGLE", title: "Forgive & Forget" });
    expect(calls("POST", "/releases")).toHaveLength(0);
    await waitFor(() => expect(calls("POST", "/provisioning/prepare")).toHaveLength(1));
    await waitFor(() => expect(screen.getByText(/\(FNF\)/)).toBeTruthy());
    expect(field.value).toBe("FNF");
    expect(walletProvider.request).not.toHaveBeenCalled();
  });

  it("withholds Deploy release contract while the prepared request is stale, until it is re-prepared", async () => {
    mockDraft();
    renderStudio("rel-draft");
    const field = await tagField();
    await preparedPanel();
    await acknowledge();
    await screen.findByRole("button", { name: /Deploy release contract/ });
    fireEvent.change(field, { target: { value: "NEWTAG" } });
    expect(screen.queryByRole("button", { name: /Deploy release contract/ })).toBeNull();
    expect(screen.getAllByRole("alert").map((node) => node.textContent).join(" ")).toMatch(/on-chain tag changed/i);
  });

  it("offers no second deployment once the creation transaction was submitted", async () => {
    mockDraft({ status: { state: "SUBMITTED", chainId: CHAIN_ID, transactionHash: `0x${"3a".repeat(32)}` } });
    renderStudio("rel-draft");
    expect(await screen.findByText(/already submitted for this release and cannot be sent again/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Deploy release contract/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Check status" })).toBeTruthy();
  });

  it("never opens the wallet when a fresh preparation differs from the parameters the artist reviewed", async () => {
    mockDraft({ onPrepare: (n) => (n === 1 ? prepared("FORGIVEFORG", DIGEST_A) : prepared("FORGIVEFORG", DIGEST_B)) });
    renderStudio("rel-draft");
    await preparedPanel();
    await acknowledge();
    fireEvent.click(await screen.findByRole("button", { name: /Deploy release contract/ }));
    await waitFor(() => expect(calls("POST", "/provisioning/prepare")).toHaveLength(2));
    expect(await screen.findByText(/parameters changed since you reviewed them/i)).toBeTruthy();
    expect(walletProvider.request).not.toHaveBeenCalled();
    expect(calls("POST", "/provisioning/submit")).toHaveLength(0);
  });

  it("saves a draft with no deployment request, no wallet request and no transaction", async () => {
    mockDraft();
    renderStudio("rel-draft");
    await tagField();
    await screen.findByDisplayValue("Forgive & Forget");
    fireEvent.click(await screen.findByRole("button", { name: "Save release draft" }));
    await waitFor(() => expect(calls("PATCH", "/studio/releases/rel-draft")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByText(/No contract was created and no gas was spent/i).length).toBeGreaterThan(0));
    expect(calls("POST", "/provisioning/prepare")).toHaveLength(0);
    expect(calls("POST", "/provisioning/submit")).toHaveLength(0);
    expect(walletProvider.request).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Deploy release contract/ })).toBeNull();
  });

  it("keeps the saved draft after a reload: it reloads from the catalog with its details and no deployment", async () => {
    mockDraft({ stored: "FNF" });
    const first = renderStudio("rel-draft");
    await tagField();
    first.unmount();
    renderStudio("rel-draft");
    expect(await screen.findByDisplayValue("Forgive & Forget")).toBeTruthy();
    expect((await tagField()).value).toBe("FNF");
    expect(calls("POST", "/provisioning/prepare")).toHaveLength(0);
    expect(walletProvider.request).not.toHaveBeenCalled();
  });

  it("deploys only after the explicit acknowledgement, and only through the Deploy release contract button", async () => {
    mockDraft();
    renderStudio("rel-draft");
    await preparedPanel();
    const deploy = await screen.findByRole("button", { name: /Deploy release contract/ });
    expect(deploy.disabled).toBe(true);
    fireEvent.click(deploy);
    expect(walletProvider.request).not.toHaveBeenCalled();
    expect(calls("POST", "/provisioning/submit")).toHaveLength(0);
    await acknowledge();
    expect(screen.getByRole("button", { name: /Deploy release contract/ }).disabled).toBe(false);
    expect(screen.getByText(/permanent contract that cannot be removed/i)).toBeTruthy();
  });

  it("locks the tag only after on-chain creation is confirmed, and shows the deployed contract's symbol", async () => {
    mockDraft({ symbol: "DRAFTVALUE", status: { state: "CONFIRMED", chainId: CHAIN_ID, symbol: "FORGIVEFORG", releaseContractAddress: CLONE, primarySaleAddress: SALE, provenanceAnchorAddress: ANCHOR } });
    renderStudio("rel-draft");
    // Confirmed creation moves Studio on to the track step; go back to the release form.
    await screen.findByText("Track details");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Catalog editor workflow" })).getByRole("button", { name: /Your release/ }));
    const field = await screen.findByLabelText(/On-chain tag \(fixed/);
    await waitFor(() => expect(field.value).toBe("FORGIVEFORG"));
    expect(field.readOnly).toBe(true);
  });
});

describe("Artist Studio with on-chain deployment switched off (the default)", () => {
  const draftCatalog = () => ({ artists, releases: [{ id: "rel-draft", artist_id: "artist-a", title: "Forgive & Forget", status: "DRAFT", release_metadata: { releaseType: "SINGLE" } }], editions: [], experiences: [] });
  const calls = () => studioFetch.mock.calls.map(([path, options]) => `${options?.method || "GET"} ${path}`);
  const mockApi = () => studioFetch.mockImplementation(async (path, options = {}) => {
    if (path === "/studio/catalog") return draftCatalog();
    if (path === "/studio/releases/rel-draft" && options.method === "PATCH") return { id: "rel-draft" };
    if (path.endsWith("/provisioning/status")) return { state: "NOT_STARTED" };
    throw new Error(`unexpected ${options.method || "GET"} ${path}`);
  });

  it("offers no way to prepare or deploy a contract, and says so", async () => {
    mockApi();
    renderStudio("rel-draft");
    expect(await screen.findByText(/On-chain deployment is switched off/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Prepare deployment|Refresh deployment/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Deploy release contract/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /permanent contract/i })).toBeNull();
  });

  it("still saves the draft, with no provisioning call and no wallet request", async () => {
    mockApi();
    renderStudio("rel-draft");
    await screen.findByDisplayValue("Forgive & Forget");
    fireEvent.click(await screen.findByRole("button", { name: "Save release draft" }));
    await waitFor(() => expect(calls()).toContain("PATCH /studio/releases/rel-draft"));
    expect(calls().filter((call) => call.includes("provisioning/prepare") || call.includes("provisioning/submit"))).toEqual([]);
    expect(walletProvider.request).not.toHaveBeenCalled();
  });

  it("shows a visible saved state below the button that names the blocker and offers no fake next action", async () => {
    mockApi();
    renderStudio("rel-draft");
    await screen.findByDisplayValue("Forgive & Forget");
    const save = await screen.findByRole("button", { name: "Save release draft" });
    fireEvent.click(save);
    const panel = await screen.findByLabelText("Release draft status");
    // The status panel is on the page before the save resolves; wait for the saved message itself.
    expect(await within(panel).findByText(/Release draft saved\. No contract was created and no gas was spent/)).toBeTruthy();
    expect(within(panel).getByText(/Contract deployment is switched off in Studio/)).toBeTruthy();
    expect(within(panel).getByText(/no next step available until deployment is switched on/)).toBeTruthy();
    // The panel follows the Save button in the page, and has no button that would lead into a server refusal.
    expect(save.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(panel).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: /Prepare deployment|Deploy release contract/ })).toBeNull();
    expect(walletProvider.request).not.toHaveBeenCalled();
  });

  it("shows a saving state, and a failure as an alert with no saved panel claim", async () => {
    studioFetch.mockImplementation(async (path, options = {}) => {
      if (path === "/studio/catalog") return draftCatalog();
      if (path === "/studio/releases/rel-draft" && options.method === "PATCH") throw new Error("Server said no.");
      if (path.endsWith("/provisioning/status")) return { state: "NOT_STARTED" };
      throw new Error(`unexpected ${options.method || "GET"} ${path}`);
    });
    renderStudio("rel-draft");
    await screen.findByDisplayValue("Forgive & Forget");
    fireEvent.click(await screen.findByRole("button", { name: "Save release draft" }));
    expect(await screen.findByText("Saving your release draft…")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Server said no/);
    expect(screen.queryByText(/Release draft saved\. No contract/)).toBeNull();
  });
});

describe("Artist Studio Save release draft replaces the existing same-title draft", () => {
  const draft = { id: "rel-draft", artist_id: "artist-a", title: "Forgive & Forget", description: "Saved description", status: "DRAFT", release_metadata: { releaseType: "SINGLE", artwork: "ipfs://saved-art" } };
  const calls = () => studioFetch.mock.calls.map(([path, options]) => `${options?.method || "GET"} ${path}`);
  const mockApi = (releases) => studioFetch.mockImplementation(async (path, options = {}) => {
    if (path === "/studio/catalog") return { artists, releases, editions: [], experiences: [] };
    if (path.startsWith("/studio/releases/") && options.method === "PATCH") return { id: path.split("/").pop() };
    if (path.endsWith("/provisioning/status")) return { state: "NOT_STARTED" };
    throw new Error(`unexpected ${options.method || "GET"} ${path}`);
  });

  it("updates the one existing draft in place instead of refusing, keeps its saved fields when the form is blank, and creates nothing", async () => {
    mockApi([draft]);
    renderStudio("");
    await waitFor(() => expect(studioFetch).toHaveBeenCalledWith("/studio/catalog", expect.anything()));
    fireEvent.change(await screen.findByLabelText(/^Release title/), { target: { value: "Forgive & Forget" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save release draft" }));
    await waitFor(() => expect(calls()).toContain("PATCH /studio/releases/rel-draft"));
    expect(calls().filter((call) => call.startsWith("POST"))).toEqual([]);
    const patch = studioFetch.mock.calls.find(([path, options]) => path === "/studio/releases/rel-draft" && options?.method === "PATCH")[1];
    expect(patch.payload).toMatchObject({ id: "rel-draft", title: "Forgive & Forget", releaseType: "SINGLE", description: "Saved description" });
    expect(screen.queryByText(/already exists/i)).toBeNull();
    expect((await screen.findAllByText(/Release draft saved\./)).length).toBeGreaterThan(0);
    expect(calls().filter((call) => call.includes("provisioning/prepare") || call.includes("provisioning/submit"))).toEqual([]);
    expect(walletProvider.request).not.toHaveBeenCalled();
  });

  it("still refuses to guess when several drafts share the title, and writes nothing", async () => {
    mockApi([draft, { ...draft, id: "rel-draft-2" }]);
    renderStudio("");
    await waitFor(() => expect(studioFetch).toHaveBeenCalledWith("/studio/catalog", expect.anything()));
    fireEvent.change(await screen.findByLabelText(/^Release title/), { target: { value: "Forgive & Forget" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save release draft" }));
    expect((await screen.findAllByText(/2 drafts named/)).length).toBeGreaterThan(0);
    expect(calls().filter((call) => call.startsWith("POST") || call.startsWith("PATCH"))).toEqual([]);
  });
});

// Production incident (2026-10-22): after the broken Forgive & Forget single was archived, Create release did
// nothing visible. A stale ?release=<archived id> in the URL put the archived release into releaseId, so each click
// PATCHed that archived release (six STUDIO_RELEASE_UPDATED events) instead of creating a new one.
describe("Artist Studio Create release with an archived release in the URL", () => {
  const ARCHIVED = "release-cd9c689c-8b90-41ee-b4e4-0124a63d6819";
  const archivedCatalog = () => ({
    artists,
    releases: [{ id: ARCHIVED, artist_id: "artist-a", title: "Forgive & Forget", status: "ARCHIVED", release_metadata: { releaseType: "SINGLE", abandoned: { reason: "ON_CHAIN_EDITION_DIVERGED_FROM_DRAFT" } } }],
    editions: [],
    experiences: [],
  });
  const calls = () => studioFetch.mock.calls.map(([path, options]) => `${options?.method || "GET"} ${path}`);
  const mockApi = () => studioFetch.mockImplementation(async (path, options = {}) => {
    if (path === "/studio/catalog") return archivedCatalog();
    if (path === "/studio/artists/artist-a/releases" && options.method === "POST") return { id: "release-new", title: options.payload.title, status: "DRAFT" };
    throw new Error(`unexpected ${options.method || "GET"} ${path}`);
  });

  it("does not load the archived release from the URL, and Save release draft makes a new draft with no deployment", async () => {
    mockApi();
    renderStudio(ARCHIVED);
    await waitFor(() => expect(studioFetch).toHaveBeenCalledWith("/studio/catalog", expect.anything()));
    fireEvent.change(await screen.findByLabelText(/^Release title/), { target: { value: "Forgive & Forget" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save release draft" }));
    await waitFor(() => expect(calls()).toContain("POST /studio/artists/artist-a/releases"));
    // Never touches the archived release, and never prepares or submits a deployment for the new draft.
    expect(calls().filter((call) => call.includes(ARCHIVED))).toEqual([]);
    expect(calls().filter((call) => call.includes("provisioning"))).toEqual([]);
    expect(walletProvider.request).not.toHaveBeenCalled();
  });

  it("shows a failure beside the button and does not claim the draft was saved when nothing was", async () => {
    studioFetch.mockImplementation(async (path, options = {}) => {
      if (path === "/studio/catalog") return archivedCatalog();
      if (path === "/studio/artists/artist-a/releases" && options.method === "POST") throw Object.assign(new Error("The release could not be created."), { code: "INTERNAL_ERROR" });
      throw new Error(`unexpected ${options.method || "GET"} ${path}`);
    });
    renderStudio(ARCHIVED);
    await waitFor(() => expect(studioFetch).toHaveBeenCalledWith("/studio/catalog", expect.anything()));
    fireEvent.change(await screen.findByLabelText(/^Release title/), { target: { value: "Forgive & Forget" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save release draft" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The release could not be created.");
    expect(alert.textContent).not.toMatch(/draft saved/i);
  });
});
