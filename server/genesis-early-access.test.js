import { describe, expect, it, vi } from "vitest";
import { Wallet, getAddress, verifyTypedData } from "ethers";
import { createGenesisClaimService, loadGenesisClaimConfig } from "./genesis-claim.js";
import { createMemoryGenesisClaimReservationStore } from "./genesis-claim-store.js";

const RELEASE = "0x2222222222222222222222222222222222222222";
const SALE = "0x3333333333333333333333333333333333333333";
const CLAIM = "0x4444444444444444444444444444444444444444";
// The owner-approved early-access wallet (a public address; no key or mapping is stored here).
const APPROVED = "0x6a86EfA012fEDA64b70112022487fEE22E67d2fb";
const OTHER = "0x1111111111111111111111111111111111111111";
// Test-only key; it holds nothing and protects nothing.
const TEST_SIGNER_KEY = `0x${"11".repeat(32)}`;
const SIGNER = new Wallet(TEST_SIGNER_KEY);
const NOW = 1_800_000_000;
const EARLY_START = NOW - 60;
const EARLY_END = NOW + 3_600;
const CLAIM_START = NOW + 7_200;
const PRICE = 250_000_000_000_000_000n;

const ENV = Object.freeze({
  GENESIS_CLAIM_ENABLED: "true",
  RELEASE_NETWORK: "fuji",
  GENESIS_RPC_URL: "https://c-chain.example/rpc",
  GENESIS_DESTINATION_RPC_URL: "https://fuji.example/rpc",
  GENESIS_CLAIM_RELEASE_CONTRACT: RELEASE,
  GENESIS_CLAIM_PRIMARY_SALE: SALE,
  GENESIS_CLAIM_CONTRACT: CLAIM,
  GENESIS_CLAIM_TOKEN_ID: "7",
  GENESIS_CLAIM_ALLOCATION: "0",
  GENESIS_PUBLIC_MINT_ALLOCATION: "0",
  GENESIS_CLAIM_START: String(CLAIM_START),
  GENESIS_PUBLIC_PRICE_WEI: PRICE.toString(),
  GENESIS_CLAIM_SIGNER_PRIVATE_KEY: TEST_SIGNER_KEY,
  GENESIS_CLAIM_SIGNER_ADDRESS: SIGNER.address,
  GENESIS_EARLY_ACCESS_ENABLED: "true",
  GENESIS_EARLY_ACCESS_WALLET: APPROVED,
  GENESIS_EARLY_ACCESS_START: String(EARLY_START),
  GENESIS_EARLY_ACCESS_END: String(EARLY_END),
});

const TYPES = {
  EarlyAccessVoucher: [
    { name: "claimant", type: "address" },
    { name: "destinationChainId", type: "uint256" },
    { name: "releaseContract", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "quantity", type: "uint256" },
    { name: "windowStart", type: "uint256" },
    { name: "windowEnd", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
const DOMAIN = { name: "The Void Genesis Holder Claim", version: "1", chainId: 43113, verifyingContract: CLAIM };

function service({ env = {}, clock = NOW, chainState = {}, bindingReader = vi.fn().mockResolvedValue(undefined) } = {}) {
  const state = { wallet: APPROVED, start: BigInt(EARLY_START), end: BigInt(EARLY_END), enabled: true, claimed: false, ...chainState };
  const genesisProvider = { getNetwork: vi.fn(), getBlockNumber: vi.fn(), call: vi.fn(), getLogs: vi.fn() };
  let counter = 1n;
  const instance = createGenesisClaimService({
    config: loadGenesisClaimConfig({ ...ENV, ...env }),
    signer: SIGNER,
    genesisProvider,
    reservationStore: createMemoryGenesisClaimReservationStore(),
    bindingReader,
    earlyAccessStateReader: async () => [state.wallet, state.start, state.end, state.enabled, state.claimed],
    claimStateReader: vi.fn(),
    clock: () => clock,
    nonce: () => counter++,
  });
  return { instance, state, genesisProvider, bindingReader };
}

describe("one-wallet early access vouchers", () => {
  it("signs a voucher for the approved wallet inside its window that recovers to the signer, without reading Genesis", async () => {
    const { instance, genesisProvider } = service();
    const { voucher, signature, target } = await instance.issueEarlyAccessVoucher(APPROVED.toLowerCase());
    expect(voucher).toMatchObject({ claimant: getAddress(APPROVED), destinationChainId: 43113, releaseContract: getAddress(RELEASE), tokenId: "7", quantity: "1", windowStart: String(EARLY_START), windowEnd: String(EARLY_END) });
    expect(Number(voucher.deadline)).toBeLessThan(EARLY_END);
    expect(verifyTypedData(DOMAIN, TYPES, voucher, signature)).toBe(SIGNER.address);
    expect(genesisProvider.call).not.toHaveBeenCalled();
    expect(JSON.stringify(target)).not.toContain(APPROVED.slice(2));
    expect(target.earlyAccess).toEqual({ start: String(EARLY_START), end: String(EARLY_END) });
  });

  it("caps the voucher deadline at the last second of the window", async () => {
    const { instance } = service({ clock: EARLY_END - 10 });
    const { voucher } = await instance.issueEarlyAccessVoucher(APPROVED);
    expect(voucher.deadline).toBe(String(EARLY_END - 1));
  });

  it("rejects any other wallet", async () => {
    await expect(service().instance.issueEarlyAccessVoucher(OTHER)).rejects.toMatchObject({ status: 403, code: "ACCESS_DENIED" });
    await expect(service().instance.issueEarlyAccessVoucher("not-a-wallet")).rejects.toMatchObject({ status: 400 });
  });

  it("rejects before the window and from the second it ends", async () => {
    await expect(service({ clock: EARLY_START - 1 }).instance.issueEarlyAccessVoucher(APPROVED)).rejects.toMatchObject({ code: "EARLY_ACCESS_NOT_OPEN" });
    await expect(service({ clock: EARLY_END }).instance.issueEarlyAccessVoucher(APPROVED)).rejects.toMatchObject({ code: "EARLY_ACCESS_CLOSED" });
  });

  it("refuses once the on-chain entitlement is used, and re-issues a fresh nonce while it is not (safe retry)", async () => {
    const { instance, state } = service();
    const first = await instance.issueEarlyAccessVoucher(APPROVED);
    const retry = await instance.issueEarlyAccessVoucher(APPROVED);
    expect(retry.voucher.nonce).not.toBe(first.voucher.nonce);
    state.claimed = true;
    await expect(instance.issueEarlyAccessVoucher(APPROVED)).rejects.toMatchObject({ status: 409, code: "ALREADY_CLAIMED" });
  });

  it.each([
    ["disabled on-chain", { enabled: false }],
    ["another wallet on-chain", { wallet: OTHER }],
    ["another window on-chain", { end: BigInt(CLAIM_START) }],
  ])("fails closed when the contract is %s", async (_, chainState) => {
    await expect(service({ chainState }).instance.issueEarlyAccessVoucher(APPROVED)).rejects.toMatchObject({ status: 503, code: "CLAIM_BINDING_MISMATCH" });
  });

  it("fails closed when the claim, release or sale binding does not verify", async () => {
    const bindingReader = vi.fn().mockRejectedValue(new Error("rpc down"));
    await expect(service({ bindingReader }).instance.issueEarlyAccessVoucher(APPROVED)).rejects.toMatchObject({ status: 503, code: "CLAIM_AUTHORIZATION_UNAVAILABLE" });
  });

  it("is unavailable unless explicitly enabled", async () => {
    const { instance } = service({ env: { GENESIS_EARLY_ACCESS_ENABLED: "" } });
    expect(instance.config.earlyAccess).toBeNull();
    await expect(instance.issueEarlyAccessVoucher(APPROVED)).rejects.toMatchObject({ code: "EARLY_ACCESS_UNAVAILABLE" });
  });

  it("does not open the regular Genesis claim early", async () => {
    await expect(service().instance.issueVoucher(APPROVED)).rejects.toMatchObject({ code: "CLAIM_NOT_OPEN" });
  });
});

describe("early access configuration", () => {
  it("normalizes a lowercase configured wallet and matches requests case-insensitively", async () => {
    const { instance } = service({ env: { GENESIS_EARLY_ACCESS_WALLET: APPROVED.toLowerCase() } });
    const { voucher } = await instance.issueEarlyAccessVoucher(APPROVED.toUpperCase().replace("0X", "0x"));
    expect(voucher.claimant).toBe(APPROVED);
  });

  it("cannot turn on anything while the Genesis claim itself is disabled", () => {
    expect(loadGenesisClaimConfig({ ...ENV, GENESIS_CLAIM_ENABLED: "" })).toBeNull();
  });

  it("still runs every base claim validation when early access is enabled", () => {
    expect(() => loadGenesisClaimConfig({ ...ENV, GENESIS_CLAIM_SIGNER_ADDRESS: OTHER })).toThrow();
    expect(() => loadGenesisClaimConfig({ ...ENV, GENESIS_CLAIM_START: "" })).toThrow();
  });

  it.each([
    ["a missing wallet", { GENESIS_EARLY_ACCESS_WALLET: "" }],
    ["the zero wallet", { GENESIS_EARLY_ACCESS_WALLET: "0x0000000000000000000000000000000000000000" }],
    ["a malformed wallet", { GENESIS_EARLY_ACCESS_WALLET: "0x1234" }],
    ["the voucher signer", { GENESIS_EARLY_ACCESS_WALLET: SIGNER.address }],
    ["the claim contract", { GENESIS_EARLY_ACCESS_WALLET: CLAIM }],
    ["the release", { GENESIS_EARLY_ACCESS_WALLET: RELEASE }],
    ["a missing start", { GENESIS_EARLY_ACCESS_START: "" }],
    ["a missing end", { GENESIS_EARLY_ACCESS_END: "" }],
    ["an end before the start", { GENESIS_EARLY_ACCESS_END: String(EARLY_START - 1) }],
    ["an end after the claim starts", { GENESIS_EARLY_ACCESS_END: String(CLAIM_START + 1) }],
  ])("fails the whole claim configuration closed for %s", (_, env) => {
    expect(() => loadGenesisClaimConfig({ ...ENV, ...env })).toThrow();
  });

  it("accepts a window that ends exactly at the claim start and keeps the paid schedule unchanged", () => {
    const config = loadGenesisClaimConfig({ ...ENV, GENESIS_EARLY_ACCESS_END: String(CLAIM_START) });
    expect(config.earlyAccess).toMatchObject({ wallet: getAddress(APPROVED), end: BigInt(CLAIM_START) });
    expect(config.publicSaleStart).toBe(BigInt(CLAIM_START));
    expect(config.claimEnd).toBe(BigInt(CLAIM_START + 86_400));
    expect(config.publicSaleEnd).toBe(BigInt(CLAIM_START + 7 * 86_400 - 1));
    expect(config.publicPriceWei).toBe(PRICE);
  });
});
