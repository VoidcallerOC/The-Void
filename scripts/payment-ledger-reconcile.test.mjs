import { describe, expect, it } from "vitest";
import { reconcilePrimarySale, reconcileSecondary, renderReport } from "./payment-ledger-reconcile.mjs";

const AVAX = 10n ** 18n;
const PLATFORM = "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4";
const ARTIST = "0x284C09a7CC187E096cBBdc88d99DEFE6df32180a";
const SALE = "0x6ae84a51f100f10f0535a514555043ae9edf9aa3";

// The one real purchase on the deployed legacy sale (tx 0xca613e8b…): 0.25 AVAX, nothing withdrawn.
const realPurchase = { paid: 250000000000000000n, artistCut: 243750000000000000n, platformCut: 6250000000000000n };

describe("primary sale reconciliation (legacy pull-payment sale, real mainnet figures)", () => {
  const base = { saleAddress: SALE, platformRecipient: PLATFORM, payouts: [ARTIST], purchased: [realPurchase], platformPaid: [], withdrawn: [], nativeBalance: 250000000000000000n, credits: { artist: 243750000000000000n, platform: 6250000000000000n } };

  it("keeps allocations, transfers and held funds separate and finds no discrepancy", () => {
    const result = reconcilePrimarySale(base);
    expect(result.problems).toEqual([]);
    expect(result.gross).toBe(250000000000000000n);
    expect(result.artist).toMatchObject({ allocation: 243750000000000000n, withdrawnToWallet: 0n, claimableNow: 243750000000000000n });
    // The platform allocation is a contract credit: nothing has reached its wallet.
    expect(result.platform).toMatchObject({ allocation: 6250000000000000n, transferredToWallet: 0n, heldAsContractCredit: 6250000000000000n });
    expect(result.heldInContract).toBe(250000000000000000n);
  });

  it("after the artist withdraws, only the platform credit remains and nothing is counted twice", () => {
    const result = reconcilePrimarySale({ ...base, withdrawn: [{ account: ARTIST, amount: 243750000000000000n }], nativeBalance: 6250000000000000n, credits: { artist: 0n, platform: 6250000000000000n } });
    expect(result.problems).toEqual([]);
    expect(result.artist).toMatchObject({ withdrawnToWallet: 243750000000000000n, claimableNow: 0n });
    expect(result.platform.transferredToWallet).toBe(0n);
    expect(result.heldInContract).toBe(6250000000000000n);
  });

  it("counts a platform wallet withdrawal as a platform transfer, never as artist money", () => {
    const result = reconcilePrimarySale({ ...base, withdrawn: [{ account: PLATFORM, amount: 6250000000000000n }], nativeBalance: 243750000000000000n, credits: { artist: 243750000000000000n, platform: 0n } });
    expect(result.problems).toEqual([]);
    expect(result.platform).toMatchObject({ transferredToWallet: 6250000000000000n, withdrawnByPlatformWallet: 6250000000000000n, pushedAtPurchase: 0n });
    expect(result.artist.withdrawnToWallet).toBe(0n);
  });

  it("flags a contract balance that does not match revenue minus transfers", () => {
    const result = reconcilePrimarySale({ ...base, nativeBalance: 240000000000000000n });
    expect(result.problems.some((problem) => /contract balance/.test(problem))).toBe(true);
  });

  it("flags an allocation that does not sum to gross revenue", () => {
    const result = reconcilePrimarySale({ ...base, purchased: [{ ...realPurchase, platformCut: 1n }] });
    expect(result.problems).toContain("allocations do not sum to gross revenue");
  });

  it("flags a credit the artist cannot actually claim", () => {
    const result = reconcilePrimarySale({ ...base, credits: { artist: 1n, platform: 6250000000000000n } });
    expect(result.problems.some((problem) => /artist claimable/.test(problem))).toBe(true);
  });
});

describe("primary sale reconciliation (settled sale: platform share pushed at purchase)", () => {
  it("shows the platform share as transferred and only the artist share held", () => {
    const result = reconcilePrimarySale({
      saleAddress: SALE, platformRecipient: PLATFORM, payouts: [ARTIST], purchased: [{ paid: AVAX, artistCut: 975000000000000000n, platformCut: 25000000000000000n }],
      platformPaid: [{ recipient: PLATFORM, amount: 25000000000000000n }], withdrawn: [], nativeBalance: 975000000000000000n, credits: { artist: 975000000000000000n, platform: 0n },
    });
    expect(result.problems).toEqual([]);
    expect(result.platform).toMatchObject({ allocation: 25000000000000000n, pushedAtPurchase: 25000000000000000n, transferredToWallet: 25000000000000000n, heldAsContractCredit: 0n });
    expect(result.heldInContract).toBe(975000000000000000n);
  });

  it("flags a platform share reported as pushed while the contract still holds it", () => {
    const result = reconcilePrimarySale({
      saleAddress: SALE, platformRecipient: PLATFORM, payouts: [ARTIST], purchased: [{ paid: AVAX, artistCut: 975000000000000000n, platformCut: 25000000000000000n }],
      platformPaid: [{ recipient: PLATFORM, amount: 25000000000000000n }], withdrawn: [], nativeBalance: AVAX, credits: { artist: 975000000000000000n, platform: 0n },
    });
    expect(result.problems.some((problem) => /contract balance/.test(problem))).toBe(true);
  });
});

describe("secondary-sale reconciliation", () => {
  it("splits 95% seller / 2.5% royalty / 2.5% platform and holds nothing", () => {
    const result = reconcileSecondary({ sold: [{ listingId: 1n, price: AVAX, platformFee: 25000000000000000n, royalty: 25000000000000000n }], nativeBalance: 0n });
    expect(result.problems).toEqual([]);
    expect(result).toMatchObject({ gross: AVAX, sellerProceeds: 950000000000000000n, artistRoyalty: 25000000000000000n, platformFee: 25000000000000000n });
  });

  it("flags a marketplace that holds AVAX or a wrong split", () => {
    const held = reconcileSecondary({ sold: [], nativeBalance: 1n });
    expect(held.problems[0]).toMatch(/must hold none/);
    const wrong = reconcileSecondary({ sold: [{ listingId: 2n, price: AVAX, platformFee: 1n, royalty: 25000000000000000n }], nativeBalance: 0n });
    expect(wrong.problems.some((problem) => /platform fee is not 2.5%/.test(problem))).toBe(true);
  });

  it("reports an empty marketplace as zero sales without inventing figures", () => {
    const result = reconcileSecondary({ sold: [], nativeBalance: 0n });
    expect(result).toMatchObject({ sales: 0, gross: 0n, sellerProceeds: 0n, artistRoyalty: 0n, platformFee: 0n, problems: [] });
  });
});

describe("report rendering", () => {
  it("labels transfers separately from contract credits", () => {
    const sale = reconcilePrimarySale({ saleAddress: SALE, platformRecipient: PLATFORM, payouts: [ARTIST], purchased: [realPurchase], platformPaid: [], withdrawn: [], nativeBalance: 250000000000000000n, credits: { artist: 243750000000000000n, platform: 6250000000000000n } });
    sale.logSource = "test";
    const text = renderReport({ chainId: 43114, latestBlock: 1, flows: { mint: { description: "d", mintRejectsAttachedAvax: true, releaseNativeBalance: 0n, problems: [] }, primary: [sale], secondary: { ...reconcileSecondary({ sold: [], nativeBalance: 0n }), logSource: "test" } } });
    expect(text).toContain("Transferred to platform wallet  0.0 AVAX");
    expect(text).toContain("platform credit 0.00625 AVAX");
  });
});
