export const APPLICATION_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "NEEDS_INFORMATION",
  "VERIFIED",
  "DECLINED",
  "REVOKED",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const PROFILE_VERIFICATION_STATUSES = [
  "NOT_APPLIED",
  "PENDING",
  "VERIFIED",
  "DECLINED",
  "REVOKED",
] as const;

export type ProfileVerificationStatus = (typeof PROFILE_VERIFICATION_STATUSES)[number];

export const ARTIST_TYPES = [
  "Musician",
  "Producer",
  "DJ",
  "Visual Artist",
  "Photographer",
  "Filmmaker",
  "Designer",
  "Writer",
  "Other",
] as const;

export type ArtistType = (typeof ARTIST_TYPES)[number];

export const LIVE_APPLICATION_STATUSES: ApplicationStatus[] = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "NEEDS_INFORMATION",
  "VERIFIED",
];

export const PENDING_REVIEW_STATUSES: ApplicationStatus[] = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "NEEDS_INFORMATION",
];

export const URL_FIELDS = [
  "websiteUrl",
  "instagramUrl",
  "tiktokUrl",
  "youtubeUrl",
  "spotifyUrl",
  "appleMusicUrl",
  "soundcloudUrl",
  "bandcampUrl",
  "otherUrl",
  "portfolioUrl",
] as const;

export type UrlField = (typeof URL_FIELDS)[number];

export type ApplicationInput = {
  artistName: string;
  legalName: string;
  email: string;
  location: string;
  artistType: string;
  websiteUrl?: string;
  instagramUrl?: string;
  tiktokUrl?: string;
  youtubeUrl?: string;
  spotifyUrl?: string;
  appleMusicUrl?: string;
  soundcloudUrl?: string;
  bandcampUrl?: string;
  otherUrl?: string;
  artistBio: string;
  workDescription: string;
  yearsActive: string;
  workUrls?: string[];
  portfolioUrl?: string;
  verificationEvidence: string;
  additionalInformation?: string;
};

export type FieldErrors = Record<string, string>;

export type ValidationResult =
  | { ok: true; value: NormalizedApplication }
  | { ok: false; errors: FieldErrors };

export type NormalizedApplication = {
  artistName: string;
  legalName: string;
  email: string;
  location: string;
  artistType: ArtistType;
  websiteUrl: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  youtubeUrl: string | null;
  spotifyUrl: string | null;
  appleMusicUrl: string | null;
  soundcloudUrl: string | null;
  bandcampUrl: string | null;
  otherUrl: string | null;
  artistBio: string;
  workDescription: string;
  yearsActive: string;
  workUrls: string[];
  portfolioUrl: string | null;
  verificationEvidence: string;
  additionalInformation: string | null;
};

export type ApplicantApplication = {
  id: string;
  publicId: string;
  artistName: string;
  status: ApplicationStatus;
  submittedAt: string | null;
  reviewedAt: string | null;
  updatedAt: string;
  decisionReason: string | null;
  informationRequest: string | null;
  applicantResponse: string | null;
  artistType: string;
  location: string;
};

export type PublicArtist = {
  slug: string;
  artistName: string;
  artistType: string;
  location: string;
  artistBio: string;
  workDescription: string;
  yearsActive: string;
  websiteUrl: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  youtubeUrl: string | null;
  spotifyUrl: string | null;
  appleMusicUrl: string | null;
  soundcloudUrl: string | null;
  bandcampUrl: string | null;
  otherUrl: string | null;
  portfolioUrl: string | null;
  workUrls: string[];
  verificationStatus: ProfileVerificationStatus;
  verifiedAt: string | null;
  isVerified: boolean;
};

export type ReviewerApplication = ApplicantApplication & {
  userId: string;
  legalName: string;
  email: string;
  websiteUrl: string | null;
  instagramUrl: string | null;
  tiktokUrl: string | null;
  youtubeUrl: string | null;
  spotifyUrl: string | null;
  appleMusicUrl: string | null;
  soundcloudUrl: string | null;
  bandcampUrl: string | null;
  otherUrl: string | null;
  artistBio: string;
  workDescription: string;
  yearsActive: string;
  workUrls: string[];
  portfolioUrl: string | null;
  verificationEvidence: string;
  additionalInformation: string | null;
  reviewerId: string | null;
  reviewNotes: string | null;
  slug: string;
};

export type DashboardState = {
  userId: string;
  isReviewer: boolean;
  canClaimReviewerSeat: boolean;
  profile: PublicArtist | null;
  application: ApplicantApplication | null;
};

export const STATUS_COPY: Record<
  ApplicationStatus,
  { label: string; applicant: string }
> = {
  DRAFT: {
    label: "Draft",
    applicant: "Your application is saved as a draft.",
  },
  SUBMITTED: {
    label: "Submitted",
    applicant: "Your verification application has been submitted.",
  },
  UNDER_REVIEW: {
    label: "Under review",
    applicant: "Your application is currently being reviewed.",
  },
  NEEDS_INFORMATION: {
    label: "Needs information",
    applicant: "Additional information is required before review can continue.",
  },
  VERIFIED: {
    label: "Verified",
    applicant: "Your artist identity is verified on The Void.",
  },
  DECLINED: {
    label: "Declined",
    applicant:
      "This application was not approved. You may submit a new application if you can provide stronger evidence of control.",
  },
  REVOKED: {
    label: "Revoked",
    applicant: "Verification for this identity is no longer active.",
  },
};
