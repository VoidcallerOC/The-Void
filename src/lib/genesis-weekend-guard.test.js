import { Interface } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { genesisClaimPhase, GENESIS_CLAIM_PHASES, readGenesisClaimSaleGuard, weekendClaimOpen } from "./genesis-claim.js";
import { claimGuardErrors } from "./sale-editor.js";

// Artist Studio's sale guard against the GenesisWeekendClaim view surface: the paid sale stays editable
// once the weekend claim closes, and while it is live only edits that keep the claim's invariants pass.
const RELEASE = "0x2222222222222222222222222222222222222222";
const SALE = "0x3333333333333333333333333333333333333333";
const CLAIM = "0x4444444444444444444444444444444444444444";
const CLOSE = 1_793_595_599n;
const binding = { chainId: 43113, releaseContractAddress: RELEASE, primarySaleAddress: SALE, tokenId: "1" };
const target = { enabled: true, mode: "weekend-merkle", destinationChainId: 43113, releaseContract: RELEASE, primarySale: SALE, claimContract: CLAIM, tokenId: "1" };
const claimIface = new Interface([
  "function releaseContract() view returns (address)", "function primarySale() view returns (address)", "function tokenId() view returns (uint256)",
  "function allocation() view returns (uint256)", "function publicAllocation() view returns (uint256)", "function claimStart() view returns (uint256)",
  "function claimEnd() view returns (uint256)", "function publicSaleStart() view returns (uint256)", "function publicSaleEnd() view returns (uint256)",
  "function publicPriceWei() view returns (uint256)", "function claimedSupply() view returns (uint256)",
]);
// Values a deployed weekend claim returns: the live sale mirrored at deployment, claimStart 0 until activation.
const onchain = { releaseContract: RELEASE, primarySale: SALE, tokenId: 1n, allocation: 0n, publicAllocation: 0n, claimStart: 0n, claimEnd: CLOSE, publicSaleStart: 1_793_019_600n, publicSaleEnd: 1_794_315_540n, publicPriceWei: 250_000_000_000_000_000n, claimedSupply: 4n };
const provider = {
  request: vi.fn(async ({ method, params }) => {
    if (method === "eth_chainId") return "0xa869";
    return claimIface.encodeFunctionResult(claimIface.parseTransaction({ data: params[0].data }).name, [onchain[claimIface.parseTransaction({ data: params[0].data }).name]]);
  }),
};
const unchanged = { priceWei: 250_000_000_000_000_000n, maxSupply: 0n, perWalletLimit: 3n, startTime: 1_793_019_600n, endTime: 1_794_315_540n, paused: false };

describe("Artist Studio guard with the Genesis weekend claim", () => {
  it("reads the weekend claim and keeps an unchanged sale editable while the claim is live", async () => {
    const claim = await readGenesisClaimSaleGuard(provider, binding, { fetchConfig: async () => target, nowSec: Number(CLOSE) - 10 });
    expect(claim).toMatchObject({ state: "active", claimContract: CLAIM, publicAllocation: 0n, claimEnd: CLOSE, live: true });
    expect(claimGuardErrors(unchanged, claim)).toEqual([]);
    expect(claimGuardErrors({ ...unchanged, maxSupply: 10n }, claim).join(" ")).toMatch(/uncapped/);
    expect(claimGuardErrors({ ...unchanged, endTime: unchanged.endTime + 3600n }, claim).join(" ")).toMatch(/still open/);
  });

  it("returns the sale to the artist after claimEnd", async () => {
    const claim = await readGenesisClaimSaleGuard(provider, binding, { fetchConfig: async () => target, nowSec: Number(CLOSE) });
    expect(claim.live).toBe(false);
    expect(claimGuardErrors({ ...unchanged, endTime: unchanged.endTime + 3600n, priceWei: 1n }, claim)).toEqual([]);
  });
});

describe("weekend claim phase", () => {
  const live = { ...target, claimEnd: String(CLOSE), publicSaleEnd: "1794315540", active: true, paused: false };
  it("is upcoming until activated, upcoming while paused, open while active, then public, then closed", () => {
    const now = Number(CLOSE) - 100;
    expect(genesisClaimPhase({ ...live, active: false, paused: true }, now)).toBe(GENESIS_CLAIM_PHASES.UPCOMING);
    expect(genesisClaimPhase({ ...live, paused: true }, now)).toBe(GENESIS_CLAIM_PHASES.UPCOMING);
    expect(genesisClaimPhase(live, now)).toBe(GENESIS_CLAIM_PHASES.GENESIS);
    expect(weekendClaimOpen(live, now)).toBe(true);
    expect(genesisClaimPhase(live, Number(CLOSE))).toBe(GENESIS_CLAIM_PHASES.PUBLIC);
    expect(weekendClaimOpen(live, Number(CLOSE))).toBe(false);
    expect(genesisClaimPhase(live, 1_794_315_541)).toBe(GENESIS_CLAIM_PHASES.CLOSED);
  });
});
