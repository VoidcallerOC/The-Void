import { describe, expect, it } from "vitest";
import { publicationResultMessage, studioPublicationPath, transactionEvidenceForOutcome, validateReleasePublish } from "./studio-publish.js";

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
