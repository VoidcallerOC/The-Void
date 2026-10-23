import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { encodeCreateReleaseAlbumTrack, encodeCreateReleaseEdition, releaseEditionIdentity } from "./fuji-release.js";
import { encodeAnchorCall } from "../../server/provenance-anchor.js";

const releaseKey = `0x${"5a".repeat(32)}`;
const artist = "0x284C09a7CC187E096cbbdc88d99DEFE6df32180a";
const one = `0x${"0".repeat(63)}1`;
const createIface = new ethers.Interface(["function createEdition(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string metadataUri, address payout, uint96 royaltyBps) returns (uint256)"]);
const albumIface = new ethers.Interface(["function createAlbumTrack(bytes32 releaseId, bytes32 editionId, uint256 maxSupply, string metadataUri, address payout, uint96 royaltyBps, bool single, uint64 mintEnd) returns (uint256)"]);
const policy = null;

describe("sequential release editions (Factory V4)", () => {
  it("signs the reserved token number as the edition ID and never hashes the title", () => {
    const encoded = encodeCreateReleaseEdition({ releaseKey, editionId: "forgive-forget", maxSupply: 0, metadataUri: "ipfs://fnf", payout: artist, royaltyBps: 250, sequentialTokenId: "1", royaltyPolicy: policy });
    expect(encoded.tokenId).toBe(1n);
    expect(encoded.editionId).toBe(one);
    const args = createIface.decodeFunctionData("createEdition", encoded.data);
    expect(args.editionId).toBe(one);
    expect(args.releaseId).toBe(releaseKey);
    expect(args.royaltyBps).toBe(250n);
  });

  it("numbers album tracks the same way", () => {
    const encoded = encodeCreateReleaseAlbumTrack({ releaseKey, editionId: "track-two", maxSupply: 0, metadataUri: "ipfs://two", payout: artist, royaltyBps: 250, sequentialTokenId: 2n, royaltyPolicy: policy });
    expect(encoded.tokenId).toBe(2n);
    expect(albumIface.decodeFunctionData("createAlbumTrack", encoded.data).editionId).toBe(`0x${"0".repeat(63)}2`);
  });

  it("keeps the title-hash derivation for earlier release contracts", () => {
    const hashed = releaseEditionIdentity({ editionId: "forgive-forget" });
    expect(hashed.tokenId.toString()).toBe("25679935302133066722236771263728427871936411831072189551573738559199048803312");
    expect(hashed.edition).toBe(ethers.encodeBytes32String("forgive-forget"));
  });

  it("anchors a sequential edition by bytes32(tokenId), not by its title", () => {
    const call = encodeAnchorCall({ releaseKey, editionTitleSlug: "forgive-forget", provenanceRoot: "ab".repeat(32), sequentialTokenId: 1n });
    expect(call).toMatchObject({ releaseId: releaseKey, editionId: one, tokenId: 1n });
  });
});
