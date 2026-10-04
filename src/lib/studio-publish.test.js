import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { encodeCreateFujiEdition } from "./fuji-release.js";
import { normalizeEditionSupply, publicationResultMessage, studioPublicationPath, transactionEvidenceForOutcome, validateReleasePublish } from "./studio-publish.js";

const validInput = {
  release: { title: "Voidcaller Full EP", type: "ep" },
  tracks: [{ title: "Track 1" }, { title: "Track 2" }],
  supply: "25",
  metadata: { artwork: "/assets/voidcaller_art_5.png", includes: ["Full self-titled EP"] },
};

describe("Release-native Studio publish validation", () => {
  it("accepts a valid release without any editionName field", () => {
    expect(validateReleasePublish(validInput)).toMatchObject({
      title: "Voidcaller Full EP",
      supply: "25",
      tracks: validInput.tracks,
    });
  });

  it("requires a release title", () => {
    expect(() => validateReleasePublish({ ...validInput, release: { ...validInput.release, title: "" } })).toThrow("Release title is required.");
  });

  it("requires at least one track", () => {
    expect(() => validateReleasePublish({ ...validInput, tracks: [] })).toThrow("At least one track is required.");
  });

  it("rejects an invalid track", () => {
    expect(() => validateReleasePublish({ ...validInput, tracks: [{ title: "" }] })).toThrow("Track 1 title is required.");
  });

  it("treats a blank or zero supply as an unlimited edition", () => {
    expect(validateReleasePublish({ ...validInput, supply: "" }).supply).toBe("0");
    expect(validateReleasePublish({ ...validInput, supply: "0" }).supply).toBe("0");
    expect(() => validateReleasePublish({ ...validInput, supply: "-1" })).toThrow(/unlimited/);
    expect(() => validateReleasePublish({ ...validInput, supply: "1.5" })).toThrow(/unlimited/);
  });

  it("sends createEdition maxSupply 0 for an open edition and a positive cap otherwise", () => {
    const payout = "0x0000000000000000000000000000000000000001";
    const iface = new ethers.Interface(["function createEdition(bytes32,bytes32,uint256,string,address,uint96)"]);
    for (const supply of ["", "0", 0, null]) {
      const quantity = normalizeEditionSupply(supply);
      expect(quantity).toBe("0");
      const encoded = encodeCreateFujiEdition({ releaseId: "fuji-test-release-001", editionId: "fuji-test-edition-001", maxSupply: quantity, metadataUri: "ipfs://test", payout, royaltyBps: 0 });
      expect(iface.decodeFunctionData("createEdition", encoded.data)[2]).toBe(0n);
    }
    const capped = normalizeEditionSupply("25");
    expect(capped).toBe("25");
    const encoded = encodeCreateFujiEdition({ releaseId: "fuji-test-release-001", editionId: "fuji-test-edition-001", maxSupply: capped, metadataUri: "ipfs://test", payout, royaltyBps: 0 });
    expect(iface.decodeFunctionData("createEdition", encoded.data)[2]).toBe(25n);
  });

  it("does not describe a release as fully published while provenance is pending or failed", () => {
    expect(publicationResultMessage({ title: "The Record", provenanceStatus: "PROVENANCE_PENDING", fullyPublished: false }).fullyPublished).toBe(false);
    expect(publicationResultMessage({ title: "The Record", provenanceStatus: "PROVENANCE_FAILED", fullyPublished: false }).message).toMatch(/not fully published/);
    expect(publicationResultMessage({ title: "The Record", provenanceStatus: "PROVENANCE_PENDING", fullyPublished: true }).fullyPublished).toBe(false);
    expect(publicationResultMessage({ title: "The Record", provenanceStatus: "PROVENANCE_VERIFIED", fullyPublished: true })).toMatchObject({ fullyPublished: true });
  });
});

describe("Studio publish route", () => {
  it("uses the saved release id for the existing metadata and confirm routes", () => {
    expect(studioPublicationPath("release-a", "metadata")).toBe("/studio/releases/release-a/metadata");
    expect(studioPublicationPath("release-a", "publication/confirm")).toBe("/studio/releases/release-a/publication/confirm");
  });

  it("does not build the collapsed path that the API reports as Route not found", () => {
    expect(() => studioPublicationPath("", "metadata")).toThrow("Save the release before publishing.");
    expect(() => studioPublicationPath("  ", "publication/confirm")).toThrow("Save the release before publishing.");
    expect(studioPublicationPath("rel/1", "metadata")).toBe("/studio/releases/rel%2F1/metadata");
  });
});

describe("Studio current transaction diagnostics", () => {
  const oldFailure = { transactionHash: "0xold", code: "REVERTED" };
  const newFailure = { transactionHash: "0xnew", code: "AccessDenied" };

  it("shows the diagnostic for a failed transaction", () => {
    expect(transactionEvidenceForOutcome({ status: "failure", evidence: oldFailure })).toEqual(oldFailure);
  });

  it("clears a previous failure after a successful transaction", () => {
    expect(transactionEvidenceForOutcome({ status: "success", evidence: oldFailure })).toBeNull();
  });

  it("shows only the latest failure after failure, success, failure", () => {
    const afterFirstFailure = transactionEvidenceForOutcome({ status: "failure", evidence: oldFailure });
    const afterSuccess = transactionEvidenceForOutcome({ status: "success", evidence: afterFirstFailure });
    const afterLatestFailure = transactionEvidenceForOutcome({ status: "failure", evidence: newFailure });
    expect(afterSuccess).toBeNull();
    expect(afterLatestFailure).toEqual(newFailure);
  });

  it("has no diagnostic after a successful transaction with no previous failure", () => {
    expect(transactionEvidenceForOutcome({ status: "success" })).toBeNull();
  });

  it("derives current evidence from the latest failed transaction error", () => {
    expect(transactionEvidenceForOutcome({
      status: "failure",
      error: { transactionHash: "0xlatest", code: "AlreadyInitialized", contractAddress: "0xcontract", chainId: 43113 },
      fallbackExplorerUrl: "https://explorer/tx/0xlatest",
    })).toEqual({ transactionHash: "0xlatest", explorerUrl: "https://explorer/tx/0xlatest", contractAddress: "0xcontract", chainId: 43113, code: "AlreadyInitialized" });
  });
});
