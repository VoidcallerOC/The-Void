import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  stripReviewerFields,
  toApplicantApplication,
  toPublicArtist,
  toReviewerApplication,
  type ApplicationRow,
  type ProfileRow,
} from "./dto.ts";

const row: ApplicationRow = {
  id: "app-1",
  public_id: "VA-APP1",
  user_id: "user-1",
  artist_profile_id: "prof-1",
  artist_name: "Voidcaller",
  legal_name: "Secret Name",
  email: "private@example.com",
  location: "CT",
  artist_type: "Musician",
  website_url: "https://voidcaller.enterthegrotto.xyz",
  instagram_url: null,
  tiktok_url: null,
  youtube_url: null,
  spotify_url: null,
  apple_music_url: null,
  soundcloud_url: null,
  bandcamp_url: null,
  other_url: null,
  artist_bio: "Bio",
  work_description: "Work",
  years_active: "10",
  work_urls_json: '["https://example.com/track"]',
  portfolio_url: null,
  verification_evidence: "Site control",
  additional_information: null,
  status: "UNDER_REVIEW",
  reviewer_id: "rev-9",
  review_notes: "INTERNAL: looks forged",
  decision_reason: null,
  information_request: null,
  applicant_response: null,
  submitted_at: "2026-09-19T00:00:00.000Z",
  reviewed_at: null,
  updated_at: "2026-09-19T00:00:00.000Z",
};

describe("dto isolation", () => {
  it("never exposes review notes to the applicant projection", () => {
    const applicant = toApplicantApplication(row);
    assert.equal("reviewNotes" in applicant, false);
    assert.equal("reviewerId" in applicant, false);
    assert.equal("legalName" in applicant, false);
    assert.equal("email" in applicant, false);
    assert.equal(applicant.status, "UNDER_REVIEW");
    assert.equal(JSON.stringify(applicant).includes("INTERNAL"), false);
  });

  it("keeps review notes on the reviewer projection only", () => {
    const review = toReviewerApplication(row, "voidcaller");
    assert.equal(review.reviewNotes, "INTERNAL: looks forged");
    assert.equal(review.legalName, "Secret Name");
    assert.equal(review.slug, "voidcaller");
  });

  it("public artist badge is backed by verification_status, not a fixture boolean", () => {
    const profile: ProfileRow = {
      id: "prof-1",
      user_id: "user-1",
      slug: "voidcaller",
      artist_name: "Voidcaller",
      legal_name: "Secret",
      email: "hidden@example.com",
      location: "CT",
      artist_type: "Musician",
      artist_bio: "Bio",
      work_description: "Work",
      years_active: "10",
      website_url: null,
      instagram_url: null,
      tiktok_url: null,
      youtube_url: null,
      spotify_url: null,
      apple_music_url: null,
      soundcloud_url: null,
      bandcamp_url: null,
      other_url: null,
      portfolio_url: null,
      work_urls_json: "[]",
      verification_status: "VERIFIED",
      verified_at: "2026-09-19T00:00:00.000Z",
    };
    const verified = toPublicArtist(profile);
    assert.equal(verified.isVerified, true);
    assert.equal("legalName" in verified, false);
    assert.equal("email" in verified, false);

    const declined = toPublicArtist({ ...profile, verification_status: "DECLINED" });
    assert.equal(declined.isVerified, false);

    const revoked = toPublicArtist({ ...profile, verification_status: "REVOKED" });
    assert.equal(revoked.isVerified, false);
  });

  it("stripReviewerFields drops private review keys", () => {
    const stripped = stripReviewerFields({
      id: "1",
      reviewNotes: "secret",
      reviewerId: "r",
      status: "SUBMITTED",
    });
    assert.equal("reviewNotes" in stripped, false);
    assert.equal("reviewerId" in stripped, false);
    assert.equal(stripped.status, "SUBMITTED");
  });
});
