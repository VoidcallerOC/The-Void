// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Interface } from "ethers";
import { MemoryRouter } from "react-router-dom";

// Mainnet build: Genesis (0xD1B4…98eE, ids 0-3) lists on the unified marketplace. Every chain read and write is mocked; nothing is broadcast.
const mocks = vi.hoisted(() => ({
  market: "0x75964C44cA586b13e98e7c30E74d2B4114f65b06",
  genesis: "0xD1B4367dd9f235f9ee61878019d66E31511E98eE",
  seller: "0xabd3746e8b852f55be52fc44fab6cab908b1c174",
  creator: "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a",
  transactionHash: `0x${"b".repeat(64)}`,
  balances: {},
  readContext: vi.fn(),
  fetchIndexedListings: vi.fn(),
  fetchAuthoritativeListing: vi.fn(),
  fetchAuthoritativeTransaction: vi.fn(),
  recordSubmission: vi.fn(),
  submitApproval: vi.fn(),
  submitListing: vi.fn(),
}));

vi.mock("../lib/secondary-listing.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readReleaseListingContext: mocks.readContext };
});
vi.mock("../lib/marketplace.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    MARKETPLACE_CONFIG: Object.freeze({ ...actual.MARKETPLACE_CONFIG, address: mocks.market, chainId: 43114, enabled: true }),
    submitApproval: mocks.submitApproval,
    submitListing: mocks.submitListing,
  };
});
vi.mock("../lib/marketplace-api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchIndexedListings: mocks.fetchIndexedListings,
    fetchAuthoritativeListing: mocks.fetchAuthoritativeListing,
    fetchAuthoritativeMarketplaceTransaction: mocks.fetchAuthoritativeTransaction,
    recordAuthoritativeTransactionSubmission: mocks.recordSubmission,
  };
});

let ListingPanel;
let WalletCtx;
beforeAll(async () => {
  vi.stubEnv("VITE_RELEASE_NETWORK", "mainnet");
  vi.stubEnv("RELEASE_NETWORK", "mainnet");
  vi.resetModules();
  ({ ListingPanel } = await import("./ListingPanel.jsx"));
  ({ WalletCtx } = await import("../lib/wallet-context.js"));
});

const genesisEdition = { id: "voidcaller-chapter-i", title: "Voidcaller Genesis", chainId: 43114, contractAddress: mocks.genesis, tokenIds: [0, 1, 2, 3] };
const erc1155 = new Interface(["function balanceOf(address account, uint256 id) view returns (uint256)"]);
const listingInterface = new Interface(["event ListingCreated(uint256 indexed listingId, address indexed seller, address indexed tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint64 expiresAt)"]);
const flushPromises = async () => { for (let index = 0; index < 24; index += 1) await Promise.resolve(); };

// The wallet's provider answers balanceOf(seller, id) from mocks.balances; any other call fails the test.
function chainProvider() {
  return {
    request: vi.fn(async ({ method, params }) => {
      if (method === "eth_chainId") return "0xa86a";
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const { to, data } = params[0];
      if (to.toLowerCase() !== mocks.genesis.toLowerCase()) throw new Error(`unexpected call to ${to}`);
      const [account, id] = erc1155.decodeFunctionData("balanceOf", data);
      if (account.toLowerCase() !== mocks.seller) throw new Error("balance read for another account");
      if (mocks.balances === "fail") throw new Error("rpc down");
      return erc1155.encodeFunctionResult("balanceOf", [BigInt(mocks.balances[String(id)] || 0)]);
    }),
  };
}

function contextFor(tokenId, overrides = {}) {
  return { balance: String(mocks.balances[String(tokenId)] || 0), approved: true, assetClass: "GENESIS", marketplaceFeeBps: "0", royaltyBps: "500", royaltyReceiver: mocks.creator, factoryAddress: null, marketplaceAddress: mocks.market, releaseContractAddress: mocks.genesis, tokenId: String(tokenId), seller: mocks.seller, chainId: 43114, ...overrides };
}

function listingReceipt(token) {
  const event = listingInterface.encodeEventLog(listingInterface.getEvent("ListingCreated"), ["7", mocks.seller, mocks.genesis, token, "1", "1000000000000000000", 0]);
  return { status: "0x1", transactionHash: mocks.transactionHash, from: mocks.seller, to: mocks.market, logs: [{ address: mocks.market, ...event }] };
}

function setup(walletOverrides = {}, url = "/") {
  const provider = chainProvider();
  const wallet = { account: mocks.seller, authenticated: true, authHeaders: { authorization: "Bearer test" }, chainId: 43114, connected: true, provider, getProvider: () => provider, authenticate: vi.fn(), ...walletOverrides };
  render(<MemoryRouter initialEntries={[url]}><WalletCtx.Provider value={wallet}><ListingPanel edition={genesisEdition} /></WalletCtx.Provider></MemoryRouter>);
  return { provider, wallet };
}
const settle = () => act(async () => { await flushPromises(); });

async function reviewAndConfirm() {
  fireEvent.change(screen.getByLabelText(/PRICE \/ EDITION/), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "REVIEW LISTING" }));
  await settle();
  const confirm = screen.getByRole("button", { name: "CONFIRM LISTING" });
  fireEvent.click(confirm);
  fireEvent.click(confirm); // a second tap while the first is in flight must not submit twice
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.balances = {};
  mocks.readContext.mockImplementation(async ({ tokenId }) => contextFor(tokenId));
  mocks.fetchIndexedListings.mockResolvedValue([]);
  mocks.fetchAuthoritativeTransaction.mockResolvedValue({ chain_id: "43114", transaction_hash: mocks.transactionHash, transaction_type: "LISTING_CREATE", status: "CONFIRMED", from_wallet: mocks.seller, to_address: mocks.market });
  mocks.recordSubmission.mockResolvedValue({ state: "PENDING" });
  mocks.submitListing.mockImplementation(async ({ tokenId }) => listingReceipt(tokenId));
  mocks.fetchAuthoritativeListing.mockImplementation(async () => ({ id: "x", listingId: "7", seller: mocks.seller, chain: 43114, marketplace: mocks.market, tokenContract: mocks.genesis, contract: mocks.genesis, tokenId: mocks.submitListing.mock.calls[0]?.[0]?.tokenId, amount: "1", initialAmount: "1", price: "1000000000000000000", status: "ACTIVE", authority: "INDEXED" }));
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

describe("Genesis listing lists the exact token the wallet holds (ids 0-3)", () => {
  for (const id of ["0", "1", "2", "3"]) {
    it(`wallet holding only token ${id}: that token is selected, verified and listed`, async () => {
      mocks.balances = { [id]: 1 };
      setup();
      await settle();
      const radio = screen.getByRole("radio", { name: `Token #${id}` });
      expect(radio.checked).toBe(true);
      expect(screen.getAllByRole("radio")).toHaveLength(1);
      expect(mocks.readContext.mock.calls.every(([args]) => args.tokenId === id)).toBe(true);
      expect(screen.getByText(new RegExp(`TOKEN ${id}$`))).toBeTruthy();
      await reviewAndConfirm();
      expect(mocks.submitListing).toHaveBeenCalledOnce();
      expect(mocks.submitListing.mock.calls[0][0]).toMatchObject({ tokenId: id, marketplace: mocks.market });
      expect(mocks.submitListing.mock.calls[0][0].edition.contractAddress).toBe(mocks.genesis);
    });
  }

  it("wallet holding several tokens chooses which one; nothing is verified or listed until it does", async () => {
    mocks.balances = { 1: 1, 3: 1 };
    setup();
    await settle();
    expect(screen.getAllByRole("radio").map((item) => item.value)).toEqual(["1", "3"]);
    expect(screen.getByText(/holds more than one of these tokens/)).toBeTruthy();
    expect(mocks.readContext).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "REVIEW LISTING" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Token #3" }));
    await settle();
    expect(mocks.readContext.mock.calls.map(([args]) => args.tokenId)).toEqual(["3"]);
    await reviewAndConfirm();
    expect(mocks.submitListing.mock.calls.map(([args]) => args.tokenId)).toEqual(["3"]);
  });

  it("wallet holding none of tokens 0-3 is blocked with an accurate message", async () => {
    setup();
    await settle();
    expect(screen.getByText(/holds none of this collection's listable tokens/)).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(mocks.readContext).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "REVIEW LISTING" })).toBeNull();
  });

  it("a token transferred away after the page loaded is caught by the pre-submit recheck", async () => {
    mocks.balances = { 2: 1 };
    setup();
    await settle();
    fireEvent.change(screen.getByLabelText(/PRICE \/ EDITION/), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "REVIEW LISTING" }));
    await settle();
    mocks.balances = {};
    fireEvent.click(screen.getByRole("button", { name: "CONFIRM LISTING" }));
    await settle();
    expect(mocks.readContext.mock.calls.at(-1)[0].tokenId).toBe("2");
    expect(mocks.submitApproval).not.toHaveBeenCalled();
    expect(mocks.submitListing).not.toHaveBeenCalled();
  });

  it("shows the unchanged Genesis economics: 0% marketplace fee, 5% royalty, 95% to the seller", async () => {
    mocks.balances = { 0: 1 };
    setup();
    await settle();
    fireEvent.change(screen.getByLabelText(/PRICE \/ EDITION/), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "REVIEW LISTING" }));
    await settle();
    expect(screen.getByText(/MARKETPLACE FEE · 0%/)).toBeTruthy();
    expect(screen.getByText(/ROYALTY · 5%/)).toBeTruthy();
    expect(screen.getByText(/ESTIMATED SELLER PROCEEDS · 95%/)).toBeTruthy();
  });

  it("stays blocked on the wrong network or a disconnected wallet, without reading balances", async () => {
    mocks.balances = { 1: 1 };
    const { provider } = setup({ chainId: 43113 });
    await settle();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(provider.request).not.toHaveBeenCalled();
    cleanup();
    const second = setup({ connected: false, account: null });
    await settle();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(second.provider.request).not.toHaveBeenCalled();
    expect(mocks.readContext).not.toHaveBeenCalled();
  });

  it("an ownership read failure blocks listing with a useful message and never assumes ownership", async () => {
    mocks.balances = "fail";
    setup();
    await settle();
    expect(screen.getByText(/On-chain ownership could not be read/)).toBeTruthy();
    expect(mocks.readContext).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "REVIEW LISTING" })).toBeNull();
  });

  it("a failed marketplace preflight for the selected token keeps listing blocked", async () => {
    mocks.balances = { 1: 1 };
    mocks.readContext.mockRejectedValue(Object.assign(new Error("The marketplace settlement for this asset does not match the recorded policy."), { code: "INVALID_ECONOMICS" }));
    setup();
    await settle();
    expect(screen.getByText(/does not match the recorded policy/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "REVIEW LISTING" })).toBeNull();
  });

  it("direct entry with ?token=: that token is the target, the selector is hidden, and it is listed", async () => {
    mocks.balances = { 0: 1, 1: 1, 3: 1 };
    setup({}, "/edition/voidcaller-chapter-i?token=3#secondary-listing");
    await settle();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByText("LISTING TOKEN #3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change token" }).getAttribute("aria-expanded")).toBe("false");
    expect(mocks.readContext.mock.calls.map(([args]) => args.tokenId)).toEqual(["3"]);
    await reviewAndConfirm();
    expect(mocks.submitListing.mock.calls.map(([args]) => args.tokenId)).toEqual(["3"]);
  });

  it("direct entry with a single held token shows no Change token control", async () => {
    mocks.balances = { 2: 1 };
    setup({}, "/edition/voidcaller-chapter-i?token=2#secondary-listing");
    await settle();
    expect(screen.getByText("LISTING TOKEN #2")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change token" })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("Change token reveals the choices on request, focuses them, and lists the newly chosen token", async () => {
    mocks.balances = { 0: 1, 3: 1 };
    setup({}, "/edition/voidcaller-chapter-i?token=3#secondary-listing");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Change token" }));
    await settle();
    expect(screen.getByRole("radio", { name: "Token #3" }).checked).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Token #3" }));
    fireEvent.click(screen.getByRole("radio", { name: "Token #0" }));
    await settle();
    expect(screen.getByRole("radio", { name: "Token #0" }).checked).toBe(true);
    expect(mocks.readContext.mock.calls.at(-1)[0].tokenId).toBe("0");
    await reviewAndConfirm();
    expect(mocks.submitListing.mock.calls.map(([args]) => args.tokenId)).toEqual(["0"]);
  });

  it("an unheld ?token= is never replaced by another token: an error, the selector, and no verification until a choice", async () => {
    for (const balances of [{ 1: 1 }, { 1: 1, 3: 1 }]) {
      cleanup();
      vi.clearAllMocks();
      mocks.readContext.mockImplementation(async ({ tokenId }) => contextFor(tokenId));
      mocks.fetchIndexedListings.mockResolvedValue([]);
      mocks.balances = balances;
      setup({}, "/edition/voidcaller-chapter-i?token=2#secondary-listing");
      await settle();
      expect(screen.getByText(/The token you chose to list is not held by this wallet/)).toBeTruthy();
      expect(screen.getAllByRole("radio").every((radio) => !radio.checked)).toBe(true);
      expect(screen.queryByRole("radio", { name: "Token #2" })).toBeNull();
      expect(mocks.readContext).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "REVIEW LISTING" })).toBeNull();
    }
    fireEvent.click(screen.getByRole("radio", { name: "Token #1" }));
    await settle();
    expect(mocks.readContext.mock.calls.map(([args]) => args.tokenId)).toEqual(["1"]);
  });

  it("without ?token= the existing selector still appears for several held tokens", async () => {
    mocks.balances = { 1: 1, 3: 1 };
    setup({}, "/edition/voidcaller-chapter-i#secondary-listing");
    await settle();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Change token" })).toBeNull();
    expect(screen.getByText(/holds more than one of these tokens/)).toBeTruthy();
  });

  it("direct entry: a token transferred away after load is still caught by the pre-submit recheck", async () => {
    mocks.balances = { 1: 1, 3: 1 };
    setup({}, "/edition/voidcaller-chapter-i?token=3#secondary-listing");
    await settle();
    fireEvent.change(screen.getByLabelText(/PRICE \/ EDITION/), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "REVIEW LISTING" }));
    await settle();
    mocks.balances = { 1: 1 };
    fireEvent.click(screen.getByRole("button", { name: "CONFIRM LISTING" }));
    await settle();
    expect(mocks.readContext.mock.calls.at(-1)[0].tokenId).toBe("3");
    expect(mocks.submitApproval).not.toHaveBeenCalled();
    expect(mocks.submitListing).not.toHaveBeenCalled();
  });
});
