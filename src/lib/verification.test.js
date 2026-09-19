import { describe, expect, it } from "vitest";
import {
  canApplicantReapply,
  canApplicantRespond,
  canReviewerTransition,
  isVerifiedStatus,
  profileStatusFromApplication,
  publicApplicationDto,
  reviewerRequiresReason,
  validateApplication,
} from "./verification.js";

describe("verification status machine", () => {
  it("allows reviewer to take a submitted application under review or decide", () => {
    expect(canReviewerTransition("SUBMITTED", "UNDER_REVIEW")).toBe(true);
    expect(canReviewerTransition("SUBMITTED", "VERIFIED")).toBe(true);
    expect(canReviewerTransition("SUBMITTED", "DECLINED")).toBe(true);
  });

  it("forbids applicants from skipping to verified via reviewer transitions they do not have", () => {
    expect(canReviewerTransition("DRAFT", "VERIFIED")).toBe(false);
    expect(canReviewerTransition("DECLINED", "VERIFIED")).toBe(false);
  });

  it("only allows revoke from verified", () => {
    expect(canReviewerTransition("VERIFIED", "REVOKED")).toBe(true);
    expect(canReviewerTransition("UNDER_REVIEW", "REVOKED")).toBe(false);
  });

  it("lets the applicant respond only when more information is required", () => {
    expect(canApplicantRespond("NEEDS_INFORMATION")).toBe(true);
    expect(canApplicantRespond("UNDER_REVIEW")).toBe(false);
  });

  it("permits reapplication after decline or revoke, not while live or verified", () => {
    expect(canApplicantReapply(null)).toBe(true);
    expect(canApplicantReapply("DECLINED")).toBe(true);
    expect(canApplicantReapply("REVOKED")).toBe(true);
    expect(canApplicantReapply("VERIFIED")).toBe(false);
    expect(canApplicantReapply("SUBMITTED")).toBe(false);
  });

  it("maps application state onto profile verification status", () => {
    expect(profileStatusFromApplication("SUBMITTED")).toBe("PENDING");
    expect(profileStatusFromApplication("VERIFIED")).toBe("VERIFIED");
  });

  it("never treats declined or revoked as verified", () => {
    expect(isVerifiedStatus("DECLINED")).toBe(false);
    expect(isVerifiedStatus("REVOKED")).toBe(false);
    expect(isVerifiedStatus("VERIFIED")).toBe(true);
  });

  it("requires a reason for decline, revoke, and information requests", () => {
    expect(reviewerRequiresReason("DECLINED")).toBe(true);
    expect(reviewerRequiresReason("VERIFIED")).toBe(false);
  });
});

describe("application validation", () => {
  const valid = {
    artistName: "Voidcaller",
    legalName: "Nicholas Sousa",
    email: "void@example.com",
    location: "Connecticut",
    artistType: "Musician",
    artistBio: "Metalcore from The Void.",
    workDescription: "On-chain records and ritual.",
    yearsActive: "10",
    verificationEvidence: "Official site and wallet-controlled studio artist.",
    websiteUrl: "https://voidcaller.enterthegrotto.xyz",
  };

  it("accepts a complete application", () => {
    const result = validateApplication(valid);
    expect(result.ok).toBe(true);
    expect(result.value.email).toBe("void@example.com");
    expect(result.value.slug).toBe("voidcaller");
  });

  it("rejects missing identity fields", () => {
    const result = validateApplication({});
    expect(result.ok).toBe(false);
    expect(result.errors.artistName).toMatch(/artist/i);
    expect(result.errors.verificationEvidence).toMatch(/verify control/i);
  });

  it("rejects private and malformed URLs", () => {
    expect(validateApplication({ ...valid, websiteUrl: "http://127.0.0.1/admin" }).ok).toBe(false);
    expect(validateApplication({ ...valid, instagramUrl: "javascript:alert(1)" }).ok).toBe(false);
  });

  it("strips control characters from submitted text", () => {
    const result = validateApplication({ ...valid, artistName: "Void\u0000caller", artistBio: "Metalcore\u0007 from The Void." });
    expect(result.ok).toBe(true);
    expect(result.value.artistName).toBe("Voidcaller");
    expect(result.value.artistBio).toBe("Metalcore from The Void.");
  });
});

describe("DTOs", () => {
  it("strips legal name and email from the public DTO", () => {
    const publicDto = publicApplicationDto({
      public_id: "va_1",
      artist_name: "Voidcaller",
      artist_type: "Musician",
      location: "CT",
      artist_bio: "Bio",
      slug: "voidcaller",
      status: "VERIFIED",
      legal_name: "secret",
      email: "secret@example.com",
      reviewed_at: "2026-09-19T00:00:00Z",
    });
    expect(publicDto.verified).toBe(true);
    expect(publicDto.legalName).toBeUndefined();
    expect(publicDto.email).toBeUndefined();
  });
});
