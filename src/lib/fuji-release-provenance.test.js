import { describe, expect, it, vi } from "vitest";
import { ethers } from "ethers";
import { encodeCreateReleaseAlbumTrack, encodeCreateReleaseEdition, explainFujiEditionError, releaseProvenanceRoot, sendReleaseProvenanceAnchor, verifyReleaseEditionCreation } from "./fuji-release.js";

const KEY = `0x${"5a".repeat(32)}`;
const ARTIST = "0x1111111111111111111111111111111111111111";
const RELEASE = "0x4444444444444444444444444444444444444444";
const ANCHOR = "0x3333333333333333333333333333333333333333";
const ROOT_HEX = "72e39f2f98fefaa1266fdeb3e9a7ed1359ce97db5d2d1130e759c15d80042e20";
const ROOT = `0x${ROOT_HEX}`;
const TX = `0x${"ab".repeat(32)}`;
const selector = (signature) => ethers.id(signature).slice(0, 10);
const base = { releaseKey: KEY, editionId: "forgive-forget", maxSupply: "0", metadataUri: "ipfs://bafy-metadata", payout: ARTIST, royaltyBps: 500 };

describe("Factory V3 creation calldata carries the provenance root", () => {
  it("encodes the V5 root-taking createEdition only when a root is supplied", () => {
    const anchored = encodeCreateReleaseEdition({ ...base, provenanceRoot: ROOT_HEX });
    expect(anchored.data.slice(0, 10)).toBe(selector("createEdition(bytes32,bytes32,uint256,string,address,uint96,bytes32)"));
    expect(anchored.provenanceRoot).toBe(ROOT);
    expect(ethers.AbiCoder.defaultAbiCoder().decode(["bytes32", "bytes32", "uint256", "string", "address", "uint96", "bytes32"], `0x${anchored.data.slice(10)}`)[6]).toBe(ROOT);
    const legacy = encodeCreateReleaseEdition(base);
    expect(legacy.data.slice(0, 10)).toBe(selector("createEdition(bytes32,bytes32,uint256,string,address,uint96)"));
    expect(legacy.provenanceRoot).toBeNull();
    expect(anchored.tokenId).toBe(legacy.tokenId);
  });

  it("encodes the V5 root-taking createAlbumTrack", () => {
    const track = encodeCreateReleaseAlbumTrack({ ...base, single: true, mintEnd: 1_900_000_000, provenanceRoot: ROOT });
    expect(track.data.slice(0, 10)).toBe(selector("createAlbumTrack(bytes32,bytes32,uint256,string,address,uint96,bool,uint64,bytes32)"));
    const args = ethers.AbiCoder.defaultAbiCoder().decode(["bytes32", "bytes32", "uint256", "string", "address", "uint96", "bool", "uint64", "bytes32"], `0x${track.data.slice(10)}`);
    expect([args[6], args[7], args[8]]).toEqual([true, 1_900_000_000n, ROOT]);
    expect(encodeCreateReleaseAlbumTrack({ ...base }).data.slice(0, 10)).toBe(selector("createAlbumTrack(bytes32,bytes32,uint256,string,address,uint96,bool,uint64)"));
  });

  it("rejects a zero or malformed root instead of encoding it", () => {
    expect(releaseProvenanceRoot(null)).toBeNull();
    expect(() => releaseProvenanceRoot(`0x${"00".repeat(32)}`)).toThrow(/non-zero/);
    expect(() => encodeCreateReleaseEdition({ ...base, provenanceRoot: "0x1234" })).toThrow(/32-byte/);
  });

  it("explains the V5 provenance reverts", () => {
    const iface = new ethers.Interface(["error InvalidRoot()", "error AlreadyAnchored(bytes32 provenanceRoot)", "error ProvenanceRootRequired()"]);
    expect(explainFujiEditionError({ data: iface.encodeErrorResult("InvalidRoot", []) })).toMatchObject({ code: "InvalidRoot", message: expect.stringMatching(/no provenance root/) });
    expect(explainFujiEditionError({ data: iface.encodeErrorResult("ProvenanceRootRequired", []) })).toMatchObject({ code: "ProvenanceRootRequired" });
    expect(explainFujiEditionError({ data: iface.encodeErrorResult("AlreadyAnchored", [ROOT]) })).toMatchObject({ code: "AlreadyAnchored", message: expect.stringMatching(/already recorded/) });
  });
});

describe("verifyReleaseEditionCreation with a provenance root", () => {
  const editionId = ethers.encodeBytes32String("forgive-forget");
  const tokenId = encodeCreateReleaseEdition(base).tokenId;
  const events = new ethers.Interface([
    "event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)",
    "event ProvenanceAnchored(bytes32 indexed provenanceRoot, bytes32 indexed releaseId, bytes32 indexed editionId, uint256 tokenId, address artist, address releaseContract)",
  ]);
  const log = (name, args, address = RELEASE) => ({ address, ...events.encodeEventLog(name, args) });
  const provider = (logs) => ({ request: vi.fn(async ({ method }) => (method === "eth_chainId" ? "0xa869" : { status: "0x1", logs })) });
  const created = log("EditionCreated", [tokenId, KEY, editionId, ARTIST, 0n, "ipfs://bafy-metadata"]);

  it("requires the release contract's ProvenanceAnchored event for the same root", async () => {
    const anchored = log("ProvenanceAnchored", [ROOT, KEY, editionId, tokenId, ARTIST, RELEASE]);
    await expect(verifyReleaseEditionCreation(provider([created, anchored]), { transactionHash: TX, releaseContractAddress: RELEASE, releaseKey: KEY, editionId: "forgive-forget", tokenId, provenanceRoot: ROOT })).resolves.toHaveProperty("provenanceEvent");
    await expect(verifyReleaseEditionCreation(provider([created]), { transactionHash: TX, releaseContractAddress: RELEASE, releaseKey: KEY, editionId: "forgive-forget", tokenId, provenanceRoot: ROOT })).rejects.toThrow(/provenance root/);
    const lookAlike = log("ProvenanceAnchored", [ROOT, KEY, editionId, tokenId, ARTIST, RELEASE], ANCHOR);
    await expect(verifyReleaseEditionCreation(provider([created, lookAlike]), { transactionHash: TX, releaseContractAddress: RELEASE, releaseKey: KEY, editionId: "forgive-forget", tokenId, provenanceRoot: ROOT })).rejects.toThrow(/provenance root/);
    await expect(verifyReleaseEditionCreation(provider([created]), { transactionHash: TX, releaseContractAddress: RELEASE, releaseKey: KEY, editionId: "forgive-forget", tokenId })).resolves.not.toHaveProperty("provenanceEvent");
  });
});

describe("sendReleaseProvenanceAnchor (one-time anchor on pre-V3 releases)", () => {
  const anchorIface = new ethers.Interface(["function anchor(bytes32 releaseId, bytes32 editionId, bytes32 provenanceRoot)"]);
  const data = anchorIface.encodeFunctionData("anchor", [KEY, ethers.encodeBytes32String("forgive-forget"), ROOT]);

  it("sends exactly the prepared anchor call to the dedicated anchor", async () => {
    const request = vi.fn(async ({ method }) => (method === "eth_chainId" ? "0xa869" : method === "eth_sendTransaction" ? TX : { status: "0x1", blockNumber: "0x5a", logs: [] }));
    await expect(sendReleaseProvenanceAnchor({ provider: { request }, from: ARTIST, prepared: { contractAddress: ANCHOR, data, provenanceRoot: ROOT_HEX }, releaseContractAddress: RELEASE })).resolves.toMatchObject({ hash: TX });
    expect(request).toHaveBeenCalledWith({ method: "eth_sendTransaction", params: [{ from: ARTIST, to: ethers.getAddress(ANCHOR), data }] });
  });

  it("refuses a release-contract target or calldata for another root before opening the wallet", async () => {
    const request = vi.fn();
    await expect(sendReleaseProvenanceAnchor({ provider: { request }, from: ARTIST, prepared: { contractAddress: RELEASE, data, provenanceRoot: ROOT_HEX }, releaseContractAddress: RELEASE })).rejects.toThrow(/dedicated/);
    await expect(sendReleaseProvenanceAnchor({ provider: { request }, from: ARTIST, prepared: { contractAddress: ANCHOR, data, provenanceRoot: "cd".repeat(32) }, releaseContractAddress: RELEASE })).rejects.toThrow(/does not commit/);
    expect(request).not.toHaveBeenCalled();
  });
});
