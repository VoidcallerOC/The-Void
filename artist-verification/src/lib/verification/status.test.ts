import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canApplicantReapply,
  canApplicantRespond,
  canReviewerTransition,
  isVerifiedStatus,
  profileStatusFromApplication,
  reviewerRequiresReason,
} from "./status.ts";

describe("verification status machine", () => {
  it("allows reviewer to take a submitted application under review or decide", () => {
    assert.equal(canReviewerTransition("SUBMITTED", "UNDER_REVIEW"), true);
    assert.equal(canReviewerTransition("SUBMITTED", "VERIFIED"), true);
    assert.equal(canReviewerTransition("SUBMITTED", "DECLINED"), true);
    assert.equal(canReviewerTransition("SUBMITTED", "NEEDS_INFORMATION"), true);
  });

  it("forbids applicants from skipping to verified via reviewer transitions they do not have", () => {
    assert.equal(canReviewerTransition("DECLINED", "VERIFIED"), false);
    assert.equal(canReviewerTransition("REVOKED", "VERIFIED"), false);
    assert.equal(canReviewerTransition("VERIFIED", "DECLINED"), false);
  });

  it("only allows revoke from verified", () => {
    assert.equal(canReviewerTransition("VERIFIED", "REVOKED"), true);
    assert.equal(canReviewerTransition("UNDER_REVIEW", "REVOKED"), false);
  });

  it("lets the applicant respond only when more information is required", () => {
    assert.equal(canApplicantRespond("NEEDS_INFORMATION"), true);
    assert.equal(canApplicantRespond("SUBMITTED"), false);
    assert.equal(canApplicantRespond("VERIFIED"), false);
  });

  it("permits reapplication after decline or revoke, not while live or verified", () => {
    assert.equal(canApplicantReapply(null), true);
    assert.equal(canApplicantReapply("DECLINED"), true);
    assert.equal(canApplicantReapply("REVOKED"), true);
    assert.equal(canApplicantReapply("SUBMITTED"), false);
    assert.equal(canApplicantReapply("VERIFIED"), false);
  });

  it("maps application state onto profile verification status", () => {
    assert.equal(profileStatusFromApplication("SUBMITTED"), "PENDING");
    assert.equal(profileStatusFromApplication("UNDER_REVIEW"), "PENDING");
    assert.equal(profileStatusFromApplication("VERIFIED"), "VERIFIED");
    assert.equal(profileStatusFromApplication("DECLINED"), "DECLINED");
    assert.equal(profileStatusFromApplication("REVOKED"), "REVOKED");
    assert.equal(profileStatusFromApplication(null), "NOT_APPLIED");
  });

  it("never treats declined or revoked as verified", () => {
    assert.equal(isVerifiedStatus("VERIFIED"), true);
    assert.equal(isVerifiedStatus("DECLINED"), false);
    assert.equal(isVerifiedStatus("REVOKED"), false);
    assert.equal(isVerifiedStatus(null), false);
  });

  it("requires a reason for decline, revoke, and information requests", () => {
    assert.equal(reviewerRequiresReason("DECLINED"), true);
    assert.equal(reviewerRequiresReason("REVOKED"), true);
    assert.equal(reviewerRequiresReason("NEEDS_INFORMATION"), true);
    assert.equal(reviewerRequiresReason("VERIFIED"), false);
  });
});
