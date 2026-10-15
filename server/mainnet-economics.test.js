import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { releaseRoyaltyPolicy, releaseRoyaltyPolicyForChain, releaseRoyaltyPolicyViolation, releasePerContractManifestFor } from "../config/release-network.js";
import { assertEditionRoyaltyPolicy } from "./studio-service.js";
import { calculateListingEconomics } from "../src/lib/secondary-listing.js";
import { encodeCreateReleaseAlbumTrack, encodeCreateReleaseEdition } from "../src/lib/fuji-release.js";

// Final mainnet economics: one passive platform fee recipient (the owner's Nano S Plus) takes 2.5%
// of primary sales and 2.5% of resales; each edition's own artist payout takes a 2.5% resale royalty;
// the seller keeps 95%. Fuji has no royalty policy and is unchanged.
const NANO = "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4";
const ARTIST = "0x00000000000000000000000000000000000A1CE0";
const RELEASE = "0x00000000000000000000000000000000000000C1";
const KEY = `0x${"11".repeat(32)}`;
const royaltyIface = new ethers.Interface(["event RoyaltyConfigured(uint256 indexed tokenId, address indexed receiver, uint96 royaltyBps)"]);
const royaltyLog = ({ tokenId = 7n, receiver = ARTIST, bps = 250, address = RELEASE } = {}) => ({ address, ...royaltyIface.encodeEventLog("RoyaltyConfigured", [tokenId, receiver, bps]) });

describe("mainnet economics", () => {
  const mainnet = releasePerContractManifestFor("mainnet");
  const policy = releaseRoyaltyPolicyForChain(43114);

  it("records one platform fee recipient for both fees and a 2.5% artist royalty, on mainnet only", () => {
    expect(mainnet).toMatchObject({ platformRecipient: NANO, marketplaceFeeRecipient: NANO, primaryFeeBps: 250, marketplaceFeeBps: 250, artistRoyaltyBps: 250, deployed: true });
    expect(policy).toEqual({ chainId: 43114, royaltyBps: 250, forbiddenReceivers: [NANO.toLowerCase()] });
    expect(releaseRoyaltyPolicyForChain(43113)).toBeNull();
    expect(releaseRoyaltyPolicy(releasePerContractManifestFor("fuji"))).toBeNull();
  });

  it("accepts only 2.5% to the artist's own wallet", () => {
    expect(releaseRoyaltyPolicyViolation(policy, { receiver: ARTIST, royaltyBps: 250n })).toBeNull();
    expect(releaseRoyaltyPolicyViolation(policy, { receiver: ARTIST, royaltyBps: 500n })).toMatch(/exactly 250/);
    expect(releaseRoyaltyPolicyViolation(policy, { receiver: ARTIST, royaltyBps: 0n })).toMatch(/exactly 250/);
    expect(releaseRoyaltyPolicyViolation(policy, { receiver: NANO, royaltyBps: 250n })).toMatch(/platform fee wallet/);
    expect(releaseRoyaltyPolicyViolation(policy, { receiver: ethers.ZeroAddress, royaltyBps: 250n })).toMatch(/artist's own wallet/);
    expect(releaseRoyaltyPolicyViolation(null, { receiver: NANO, royaltyBps: 900n })).toBeNull();
  });

  it("publishes a mainnet edition only when its creation receipt records 2.5% to a non-platform payout", () => {
    const base = { publicationContract: RELEASE, tokenId: 7n, policy };
    expect(() => assertEditionRoyaltyPolicy({ ...base, receipt: { logs: [royaltyLog()] } })).not.toThrow();
    expect(() => assertEditionRoyaltyPolicy({ ...base, receipt: { logs: [royaltyLog({ bps: 500 })] } })).toThrow(/exactly 250/);
    expect(() => assertEditionRoyaltyPolicy({ ...base, receipt: { logs: [royaltyLog({ receiver: NANO })] } })).toThrow(/platform fee wallet/);
    // A look-alike event from another contract, or for another token, does not count.
    expect(() => assertEditionRoyaltyPolicy({ ...base, receipt: { logs: [royaltyLog({ address: "0x00000000000000000000000000000000000000C2" })] } })).toThrow(/does not record/);
    expect(() => assertEditionRoyaltyPolicy({ ...base, receipt: { logs: [royaltyLog({ tokenId: 8n })] } })).toThrow(/does not record/);
    expect(() => assertEditionRoyaltyPolicy({ ...base, policy: null, receipt: { logs: [] } })).not.toThrow();
  });

  it("refuses to encode a mainnet edition or album track with any other royalty or a platform payout", () => {
    const edition = { releaseKey: KEY, editionId: "track-one", maxSupply: 10, metadataUri: "ipfs://meta", payout: ARTIST, royaltyPolicy: policy };
    expect(encodeCreateReleaseEdition({ ...edition, royaltyBps: 250 }).data).toMatch(/^0x/);
    expect(() => encodeCreateReleaseEdition({ ...edition, royaltyBps: 500 })).toThrow(/exactly 250/);
    expect(() => encodeCreateReleaseEdition({ ...edition, royaltyBps: 250, payout: NANO })).toThrow(/platform fee wallet/);
    expect(() => encodeCreateReleaseAlbumTrack({ ...edition, royaltyBps: 0 })).toThrow(/exactly 250/);
    // Fuji (no policy) keeps the artist's choice.
    expect(encodeCreateReleaseEdition({ ...edition, royaltyPolicy: null, royaltyBps: 500 }).data).toMatch(/^0x/);
  });

  it("shows a 1 AVAX resale as 0.025 royalty, 0.025 marketplace fee and 0.95 to the seller", () => {
    expect(calculateListingEconomics({ priceWei: ethers.parseEther("1").toString(), amount: "1", marketplaceFeeBps: "250", royaltyBps: "250" })).toMatchObject({
      marketplaceFeeWei: ethers.parseEther("0.025").toString(),
      royaltyWei: ethers.parseEther("0.025").toString(),
      sellerProceedsWei: ethers.parseEther("0.95").toString(),
      sellerProceedsBps: "9500",
    });
  });
});
