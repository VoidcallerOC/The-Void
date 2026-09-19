export const APPLICATION_STATUSES = Object.freeze([
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "NEEDS_INFORMATION",
  "VERIFIED",
  "DECLINED",
  "REVOKED",
]);

export const ARTIST_TYPES = Object.freeze([
  "Musician",
  "Producer",
  "DJ",
  "Visual Artist",
  "Photographer",
  "Filmmaker",
  "Designer",
  "Writer",
  "Other",
]);

export const LIVE_APPLICATION_STATUSES = Object.freeze([
  "DRAFT",
  "SUBMITTED",
  "UNDER_REVIEW",
  "NEEDS_INFORMATION",
  "VERIFIED",
]);

export const PENDING_REVIEW_STATUSES = Object.freeze([
  "SUBMITTED",
  "UNDER_REVIEW",
  "NEEDS_INFORMATION",
]);

export const URL_FIELDS = Object.freeze([
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
]);

const REVIEWER_TRANSITIONS = Object.freeze({
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["UNDER_REVIEW", "NEEDS_INFORMATION", "VERIFIED", "DECLINED"],
  UNDER_REVIEW: ["NEEDS_INFORMATION", "VERIFIED", "DECLINED", "UNDER_REVIEW"],
  NEEDS_INFORMATION: ["UNDER_REVIEW", "VERIFIED", "DECLINED"],
  VERIFIED: ["REVOKED"],
  DECLINED: [],
  REVOKED: [],
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const MAX_SHORT = 160;
const MAX_LONG = 4000;
const MAX_URL = 2048;

export function canReviewerTransition(from, to) {
  return (REVIEWER_TRANSITIONS[from] || []).includes(to);
}

export function canApplicantRespond(status) {
  return status === "NEEDS_INFORMATION";
}

export function canApplicantReapply(status) {
  if (!status) return true;
  return status === "DECLINED" || status === "REVOKED";
}

export function profileStatusFromApplication(status) {
  if (!status || status === "DRAFT") return "NOT_APPLIED";
  if (status === "SUBMITTED" || status === "UNDER_REVIEW" || status === "NEEDS_INFORMATION") return "PENDING";
  if (status === "VERIFIED") return "VERIFIED";
  if (status === "DECLINED") return "DECLINED";
  if (status === "REVOKED") return "REVOKED";
  return "NOT_APPLIED";
}

export function isVerifiedStatus(status) {
  return status === "VERIFIED";
}

export function reviewerRequiresReason(to) {
  return to === "DECLINED" || to === "REVOKED" || to === "NEEDS_INFORMATION";
}

export function trimToNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function stripControlChars(value) {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) out += ch;
  }
  return out;
}

export function sanitizeText(value, max) {
  if (typeof value !== "string") return "";
  return stripControlChars(value).replace(/\s+/g, " ").trim().slice(0, max);
}

export function sanitizeMultiline(value, max) {
  if (typeof value !== "string") return "";
  return stripControlChars(value).replace(/\r\n/g, "\n").trim().slice(0, max);
}

export function isAllowedHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!parsed.hostname.includes(".")) return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return false;
  if (/^(10|127)\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
  if (host.startsWith("[") || host.includes(":")) return false;
  return true;
}

export function normalizeUrl(value) {
  const raw = trimToNull(typeof value === "string" ? value : "");
  if (!raw) return { ok: true, url: null };
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  if (candidate.length > MAX_URL || !isAllowedHttpUrl(candidate)) return { ok: false };
  return { ok: true, url: candidate };
}

function requireText(errors, field, value, message, max, multiline = false) {
  const text = multiline ? sanitizeMultiline(value, max) : sanitizeText(value, max);
  if (!text) errors[field] = message;
  return text;
}

export function slugFromName(value) {
  return sanitizeText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function validateApplication(input = {}) {
  const errors = {};
  const artistName = requireText(errors, "artistName", input.artistName, "Enter your artist/stage name.", MAX_SHORT);
  const legalName = requireText(errors, "legalName", input.legalName, "Enter the legal name of the person or entity that controls this identity.", MAX_SHORT);
  const emailRaw = requireText(errors, "email", input.email, "Enter a contact email.", 254);
  const email = emailRaw.toLowerCase();
  if (emailRaw && !EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
  const location = requireText(errors, "location", input.location, "Enter a location.", MAX_SHORT);
  const artistTypeRaw = sanitizeText(input.artistType, 40);
  if (!ARTIST_TYPES.includes(artistTypeRaw)) errors.artistType = "Select an artist type.";
  const artistType = ARTIST_TYPES.includes(artistTypeRaw) ? artistTypeRaw : "Other";
  const artistBio = requireText(errors, "artistBio", input.artistBio, "Enter a short artist bio.", 800, true);
  const workDescription = requireText(errors, "workDescription", input.workDescription, "Describe the work you make.", MAX_LONG, true);
  const yearsActive = requireText(errors, "yearsActive", input.yearsActive, "Enter how many years you have been active.", 40);
  const verificationEvidence = requireText(
    errors,
    "verificationEvidence",
    input.verificationEvidence,
    "Please provide at least one way to verify control of this artist identity.",
    MAX_LONG,
    true,
  );

  const urls = {};
  for (const field of URL_FIELDS) {
    const result = normalizeUrl(input[field]);
    if (!result.ok) errors[field] = "Enter a valid http(s) URL.";
    urls[field] = result.ok ? result.url : null;
  }

  const workUrls = [];
  const rawWork = Array.isArray(input.workUrls) ? input.workUrls : [];
  for (const [index, entry] of rawWork.slice(0, 3).entries()) {
    const result = normalizeUrl(entry);
    if (!result.ok) errors[`workUrls.${index}`] = "Enter a valid http(s) URL.";
    else if (result.url) workUrls.push(result.url);
  }

  const additionalInformation = sanitizeMultiline(input.additionalInformation, MAX_LONG) || null;
  const ok = Object.keys(errors).length === 0;
  return {
    ok,
    errors,
    value: ok
      ? {
          artistName,
          legalName,
          email,
          location,
          artistType,
          artistBio,
          workDescription,
          yearsActive,
          verificationEvidence,
          additionalInformation,
          workUrls,
          slug: slugFromName(artistName),
          ...urls,
        }
      : null,
  };
}

export function publicApplicationDto(row) {
  if (!row) return null;
  return {
    publicId: row.public_id,
    artistName: row.artist_name,
    artistType: row.artist_type,
    location: row.location,
    artistBio: row.artist_bio,
    slug: row.slug,
    artistId: row.artist_id || null,
    status: row.status,
    verified: row.status === "VERIFIED",
    verifiedAt: row.status === "VERIFIED" ? row.reviewed_at : null,
  };
}

export function applicantApplicationDto(row) {
  if (!row) return null;
  return {
    ...publicApplicationDto(row),
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
    portfolioUrl: row.portfolio_url,
    workUrls: Array.isArray(row.work_urls) ? row.work_urls : [],
    informationRequest: row.information_request || null,
    decisionReason: row.status === "DECLINED" || row.status === "REVOKED" || row.status === "NEEDS_INFORMATION" ? row.decision_reason : null,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    profileStatus: profileStatusFromApplication(row.status),
  };
}

export function reviewerApplicationDto(row) {
  if (!row) return null;
  return {
    ...applicantApplicationDto(row),
    id: row.id,
    walletAddress: row.wallet_address,
    legalName: row.legal_name,
    workDescription: row.work_description,
    yearsActive: row.years_active,
    verificationEvidence: row.verification_evidence,
    additionalInformation: row.additional_information,
    reviewNotes: row.review_notes,
    applicantResponse: row.applicant_response,
    decisionReason: row.decision_reason,
  };
}
