import {
  ARTIST_TYPES,
  URL_FIELDS,
  type ApplicationInput,
  type ArtistType,
  type FieldErrors,
  type NormalizedApplication,
  type ValidationResult,
} from "./types.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const MAX_SHORT = 160;
const MAX_LONG = 4000;
const MAX_URL = 2048;

export function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

export function stripControlChars(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export function sanitizeText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return stripControlChars(value).replace(/\s+/g, " ").trim().slice(0, max);
}

export function sanitizeMultiline(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return stripControlChars(value).replace(/\r\n/g, "\n").trim().slice(0, max);
}

export function isAllowedHttpUrl(value: string): boolean {
  let parsed: URL;
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

export function normalizeUrl(value: unknown): { ok: true; url: string | null } | { ok: false } {
  const raw = trimToNull(typeof value === "string" ? value : "");
  if (!raw) return { ok: true, url: null };
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  if (candidate.length > MAX_URL || !isAllowedHttpUrl(candidate)) return { ok: false };
  return { ok: true, url: candidate };
}

function requireText(
  errors: FieldErrors,
  field: string,
  value: unknown,
  message: string,
  max: number,
  multiline = false,
): string {
  const text = multiline ? sanitizeMultiline(value, max) : sanitizeText(value, max);
  if (!text) errors[field] = message;
  return text;
}

export function validateApplication(input: ApplicationInput): ValidationResult {
  const errors: FieldErrors = {};

  const artistName = requireText(errors, "artistName", input.artistName, "Enter your artist/stage name.", MAX_SHORT);
  const legalName = requireText(errors, "legalName", input.legalName, "Enter the legal name of the person or entity that controls this identity.", MAX_SHORT);
  const emailRaw = requireText(errors, "email", input.email, "Enter a contact email.", 254);
  const email = emailRaw.toLowerCase();
  if (emailRaw && !EMAIL_RE.test(email)) errors.email = "Enter a valid email address.";
  const location = requireText(errors, "location", input.location, "Enter a location.", MAX_SHORT);

  const artistTypeRaw = sanitizeText(input.artistType, 40);
  if (!ARTIST_TYPES.includes(artistTypeRaw as ArtistType)) {
    errors.artistType = "Select an artist type.";
  }
  const artistType = (ARTIST_TYPES.includes(artistTypeRaw as ArtistType) ? artistTypeRaw : "Other") as ArtistType;

  const artistBio = requireText(errors, "artistBio", input.artistBio, "Enter a short artist bio.", 800, true);
  const workDescription = requireText(
    errors,
    "workDescription",
    input.workDescription,
    "Describe the work you make.",
    MAX_LONG,
    true,
  );
  const yearsActive = requireText(errors, "yearsActive", input.yearsActive, "Enter how many years you have been active.", 40);
  const verificationEvidence = requireText(
    errors,
    "verificationEvidence",
    input.verificationEvidence,
    "Please provide at least one way to verify control of this artist identity.",
    MAX_LONG,
    true,
  );

  const urls: Record<(typeof URL_FIELDS)[number], string | null> = {
    websiteUrl: null,
    instagramUrl: null,
    tiktokUrl: null,
    youtubeUrl: null,
    spotifyUrl: null,
    appleMusicUrl: null,
    soundcloudUrl: null,
    bandcampUrl: null,
    otherUrl: null,
    portfolioUrl: null,
  };

  for (const field of URL_FIELDS) {
    const result = normalizeUrl(input[field]);
    if (!result.ok) {
      errors[field] = "Please enter a valid URL.";
    } else {
      urls[field] = result.url;
    }
  }

  const workUrls: string[] = [];
  const incoming = Array.isArray(input.workUrls) ? input.workUrls : [];
  for (const item of incoming.slice(0, 3)) {
    const result = normalizeUrl(item);
    if (!result.ok) {
      errors.workUrls = "Please enter a valid URL.";
      continue;
    }
    if (result.url) workUrls.push(result.url);
  }
  if (incoming.filter((v) => trimToNull(v)).length > 3) {
    errors.workUrls = "Provide up to three representative work URLs.";
  }

  const additionalInformation = sanitizeMultiline(input.additionalInformation, MAX_LONG) || null;

  const hasControlSignal = Boolean(
    verificationEvidence.length >= 12 ||
      urls.websiteUrl ||
      urls.instagramUrl ||
      urls.tiktokUrl ||
      urls.youtubeUrl ||
      urls.spotifyUrl ||
      urls.appleMusicUrl ||
      urls.soundcloudUrl ||
      urls.bandcampUrl ||
      urls.otherUrl ||
      urls.portfolioUrl ||
      workUrls.length,
  );
  if (!hasControlSignal) {
    errors.verificationEvidence =
      "Please provide at least one way to verify control of this artist identity.";
  }

  if (Object.keys(errors).length) return { ok: false, errors };

  const value: NormalizedApplication = {
    artistName,
    legalName,
    email,
    location,
    artistType,
    websiteUrl: urls.websiteUrl,
    instagramUrl: urls.instagramUrl,
    tiktokUrl: urls.tiktokUrl,
    youtubeUrl: urls.youtubeUrl,
    spotifyUrl: urls.spotifyUrl,
    appleMusicUrl: urls.appleMusicUrl,
    soundcloudUrl: urls.soundcloudUrl,
    bandcampUrl: urls.bandcampUrl,
    otherUrl: urls.otherUrl,
    artistBio,
    workDescription,
    yearsActive,
    workUrls,
    portfolioUrl: urls.portfolioUrl,
    verificationEvidence,
    additionalInformation,
  };
  return { ok: true, value };
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48);
  return base || "artist";
}

export function makePublicId(id: string): string {
  return `VA-${id.replace(/-/g, "").slice(0, 10).toUpperCase()}`;
}
