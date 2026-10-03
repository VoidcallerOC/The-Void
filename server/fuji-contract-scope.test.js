import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import {
  CANONICAL_FUJI_CHAIN_ID,
  CANONICAL_FUJI_RELEASE,
  C_CHAIN_VOIDCALLER_COLLECTION,
  LEGACY_FUJI_V1_RELEASE,
  certifiedTokenJoinSql,
  editionCreatedLogMatches,
  isCanonicalFujiRelease,
  isLegacyFujiV1Release,
  isOutOfScopeCChainCollection,
  reuseExistingMetadataForCertifiedToken,
  selectCertifiedEditionToken,
} from "./fuji-contract-scope.js";

describe("Fuji contract scope", () => {
  it("keeps V2, V1, and C-Chain addresses in separate buckets", () => {
    expect(CANONICAL_FUJI_CHAIN_ID).toBe(43113);
    expect(isCanonicalFujiRelease("0x7Bba0690a43E2FFE9ad553fbDa0451177B7B95B6")).toBe(true);
    expect(isCanonicalFujiRelease(LEGACY_FUJI_V1_RELEASE)).toBe(false);
    expect(isLegacyFujiV1Release("0x262B774cf9a1949170B58E2d57F6189980FE757b")).toBe(true);
    expect(isOutOfScopeCChainCollection("0xd1b4367dd9f235f9ee61878019d66e31511e98ee")).toBe(true);
    expect(C_CHAIN_VOIDCALLER_COLLECTION).not.toBe(CANONICAL_FUJI_RELEASE);
    expect(LEGACY_FUJI_V1_RELEASE).not.toBe(CANONICAL_FUJI_RELEASE);
  });

  it("selects the token row for the canonical contract and refuses ambiguous rows", () => {
    const v1 = { contract_address: LEGACY_FUJI_V1_RELEASE, chain_id: 43113, token_id: "9" };
    const v2 = { contract_address: CANONICAL_FUJI_RELEASE, chain_id: 43113, token_id: "9" };
    const cChain = { contract_address: C_CHAIN_VOIDCALLER_COLLECTION, chain_id: 43114, token_id: "9" };
    expect(selectCertifiedEditionToken([v1, cChain, v2]).token_id).toBe("9");
    expect(selectCertifiedEditionToken([v1, cChain])).toBeNull();
    expect(() => selectCertifiedEditionToken([v2, { ...v2, token_id: "10" }])).toThrow(/ambiguous/);
  });

  it("joins tokens only through the canonical Fuji contract subquery", () => {
    const sql = certifiedTokenJoinSql();
    expect(sql).toContain("t.edition_id=e.id");
    expect(sql).toContain("lower(address)=$2");
    expect(sql).toContain("chain_id=$3");
    expect(sql).not.toContain(LEGACY_FUJI_V1_RELEASE);
  });

  it("rejects EditionCreated logs from V1 or C-Chain even when token IDs match", () => {
    const iface = new ethers.Interface(["event EditionCreated(uint256 indexed tokenId, bytes32 indexed releaseId, bytes32 indexed editionId, address artist, uint256 maxSupply, string metadataUri)"]);
    const releaseId = ethers.encodeBytes32String("same-release");
    const editionId = ethers.encodeBytes32String("same-edition");
    const tokenId = 9n;
    const data = iface.encodeEventLog("EditionCreated", [tokenId, releaseId, editionId, "0x1111111111111111111111111111111111111111", 25n, "ipfs://cid"]);
    const parsed = iface.parseLog({ ...data, address: LEGACY_FUJI_V1_RELEASE });
    expect(editionCreatedLogMatches({
      log: { address: LEGACY_FUJI_V1_RELEASE },
      parsed,
      contractAddress: CANONICAL_FUJI_RELEASE,
      expectedTokenId: tokenId,
      expectedReleaseId: releaseId,
      expectedEditionId: editionId,
      expectedMetadataUri: "ipfs://cid",
    })).toBe(false);
    expect(editionCreatedLogMatches({
      log: { address: CANONICAL_FUJI_RELEASE },
      parsed,
      contractAddress: CANONICAL_FUJI_RELEASE,
      expectedTokenId: tokenId,
      expectedReleaseId: releaseId,
      expectedEditionId: editionId,
      expectedMetadataUri: "ipfs://cid",
    })).toBe(true);
  });

  it("reuses an existing CID for a new V2 token without rewriting V1 history", () => {
    const existing = { metadata_uri: "ipfs://same-cid", metadata: { name: "kept" }, metadata_version: "abc", contract_address: LEGACY_FUJI_V1_RELEASE };
    const result = reuseExistingMetadataForCertifiedToken({ existingToken: existing, certifiedToken: null });
    expect(result.action).toBe("clone-metadata-to-certified");
    expect(result.token.metadata_uri).toBe("ipfs://same-cid");
    expect(result.token.source_contract_address).toBe(LEGACY_FUJI_V1_RELEASE);
    expect(reuseExistingMetadataForCertifiedToken({ existingToken: existing, certifiedToken: { metadata_uri: "ipfs://v2-cid" } }).action).toBe("keep-certified");
  });
});
