import { isVerifiedStatus, profileStatusFromApplication } from "./status.ts";
import type {
  ApplicantApplication,
  ApplicationStatus,
  PublicArtist,
  ReviewerApplication,
} from "./types";

export type ApplicationRow = {
  id: string;
  public_id: string;
  user_id: string;
  artist_profile_id: string;
  artist_name: string;
  legal_name: string;
  email: string;
  location: string;
  artist_type: string;
  website_url: string | null;
  instagram_url: string | null;
  tiktok_url: string | null;
  youtube_url: string | null;
  spotify_url: string | null;
  apple_music_url: string | null;
  soundcloud_url: string | null;
  bandcamp_url: string | null;
  other_url: string | null;
  artist_bio: string;
  work_description: string;
  years_active: string;
  work_urls_json: string;
  portfolio_url: string | null;
  verification_evidence: string;
  additional_information: string | null;
  status: ApplicationStatus;
  reviewer_id: string | null;
  review_notes: string | null;
  decision_reason: string | null;
  information_request: string | null;
  applicant_response: string | null;
  submitted_at: string | Date | null;
  reviewed_at: string | Date | null;
  updated_at: string | Date;
};

export type ProfileRow = {
  id: string;
  user_id: string;
  slug: string;
  artist_name: string;
  legal_name: string;
  email: string;
  location: string;
  artist_type: string;
  artist_bio: string;
  work_description: string;
  years_active: string;
  website_url: string | null;
  instagram_url: string | null;
  tiktok_url: string | null;
  youtube_url: string | null;
  spotify_url: string | null;
  apple_music_url: string | null;
  soundcloud_url: string | null;
  bandcamp_url: string | null;
  other_url: string | null;
  portfolio_url: string | null;
  work_urls_json: string;
  verification_status: PublicArtist["verificationStatus"];
  verified_at: string | Date | null;
};

function iso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function parseWorkUrls(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function toApplicantApplication(row: ApplicationRow): ApplicantApplication {
  return {
    id: row.id,
    publicId: row.public_id,
    artistName: row.artist_name,
    status: row.status,
    submittedAt: iso(row.submitted_at),
    reviewedAt: iso(row.reviewed_at),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
    decisionReason: row.decision_reason,
    informationRequest: row.information_request,
    applicantResponse: row.applicant_response,
    artistType: row.artist_type,
    location: row.location,
  };
}

export function toReviewerApplication(row: ApplicationRow, slug: string): ReviewerApplication {
  return {
    ...toApplicantApplication(row),
    userId: row.user_id,
    legalName: row.legal_name,
    email: row.email,
    websiteUrl: row.website_url,
    instagramUrl: row.instagram_url,
    tiktokUrl: row.tiktok_url,
    youtubeUrl: row.youtube_url,
    spotifyUrl: row.spotify_url,
    appleMusicUrl: row.apple_music_url,
    soundcloudUrl: row.soundcloud_url,
    bandcampUrl: row.bandcamp_url,
    otherUrl: row.other_url,
    artistBio: row.artist_bio,
    workDescription: row.work_description,
    yearsActive: row.years_active,
    workUrls: parseWorkUrls(row.work_urls_json),
    portfolioUrl: row.portfolio_url,
    verificationEvidence: row.verification_evidence,
    additionalInformation: row.additional_information,
    reviewerId: row.reviewer_id,
    reviewNotes: row.review_notes,
    slug,
  };
}

export function toPublicArtist(row: ProfileRow): PublicArtist {
  const status = row.verification_status ?? profileStatusFromApplication(null);
  return {
    slug: row.slug,
    artistName: row.artist_name,
    artistType: row.artist_type,
    location: row.location,
    artistBio: row.artist_bio,
    workDescription: row.work_description,
    yearsActive: row.years_active,
    websiteUrl: row.website_url,
    instagramUrl: row.instagram_url,
    tiktokUrl: row.tiktok_url,
    youtubeUrl: row.youtube_url,
    spotifyUrl: row.spotify_url,
    appleMusicUrl: row.apple_music_url,
    soundcloudUrl: row.soundcloud_url,
    bandcampUrl: row.bandcamp_url,
    otherUrl: row.other_url,
    portfolioUrl: row.portfolio_url,
    workUrls: parseWorkUrls(row.work_urls_json),
    verificationStatus: status,
    verifiedAt: iso(row.verified_at),
    isVerified: isVerifiedStatus(status),
  };
}

export function stripReviewerFields<T extends { reviewNotes?: string | null; reviewerId?: string | null }>(
  value: T,
): Omit<T, "reviewNotes" | "reviewerId"> {
  const { reviewNotes: _notes, reviewerId: _reviewer, ...rest } = value;
  return rest;
}
