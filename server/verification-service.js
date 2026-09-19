import { randomUUID } from "node:crypto";
import process from "node:process";
import { ApiError } from "./api-errors.js";
import { requireWalletAuth } from "./api-runtime.js";
import {
  LIVE_APPLICATION_STATUSES,
  PENDING_REVIEW_STATUSES,
  applicantApplicationDto,
  canApplicantReapply,
  canApplicantRespond,
  canReviewerTransition,
  publicApplicationDto,
  reviewerApplicationDto,
  reviewerRequiresReason,
  validateApplication,
} from "../src/lib/verification.js";

function parseReviewerWallets(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^0x[0-9a-f]{40}$/.test(entry));
}

function publicId() {
  return `va_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function createArtistVerificationService({
  db,
  authenticator,
  reviewerWallets = process.env.VERIFICATION_REVIEWER_WALLETS,
  logger = console,
} = {}) {
  if (!db?.query || typeof authenticator !== "function") {
    throw new TypeError("ArtistVerificationService requires persistence and wallet authentication.");
  }
  const seededReviewers = new Set(parseReviewerWallets(reviewerWallets));

  async function identity(request) {
    return requireWalletAuth(authenticator, request);
  }

  async function isReviewer(wallet) {
    if (seededReviewers.has(wallet)) return true;
    const { rows } = await db.query("SELECT wallet_address FROM verification_reviewers WHERE wallet_address=$1 LIMIT 1", [wallet]);
    return Boolean(rows[0]);
  }

  async function requireReviewer(request) {
    const id = await identity(request);
    if (!(await isReviewer(id.wallet))) throw new ApiError(403, "REVIEWER_REQUIRED", "This wallet is not authorized to review artist verification applications.");
    return id;
  }

  async function liveApplication(wallet) {
    const { rows } = await db.query(
      `SELECT * FROM artist_verification_applications WHERE wallet_address=$1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 1`,
      [wallet, LIVE_APPLICATION_STATUSES],
    );
    return rows[0] || null;
  }

  async function recordEvent({ applicationId, fromStatus, toStatus, actorWallet, actorRole, reason = null }) {
    await db.query(
      `INSERT INTO verification_status_events (id, application_id, from_status, to_status, actor_wallet, actor_role, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), applicationId, fromStatus, toStatus, actorWallet, actorRole, reason],
    );
  }

  async function bumpSubmitLimit(wallet) {
    const windowStart = new Date();
    windowStart.setUTCMinutes(0, 0, 0);
    const { rows } = await db.query(
      `INSERT INTO verification_rate_limits (wallet_address, action, window_start, count)
       VALUES ($1,'submit',$2,1)
       ON CONFLICT (wallet_address, action, window_start)
       DO UPDATE SET count = verification_rate_limits.count + 1
       RETURNING count`,
      [wallet, windowStart.toISOString()],
    );
    if (Number(rows[0]?.count || 0) > 5) throw new ApiError(429, "RATE_LIMITED", "Too many verification submissions from this wallet. Try again later.");
  }

  async function getMine({ request }) {
    const id = await identity(request);
    const reviewer = await isReviewer(id.wallet);
    const row = await liveApplication(id.wallet);
    if (row) return { application: applicantApplicationDto(row), canReapply: canApplicantReapply(row.status), reviewer };
    const { rows } = await db.query(
      `SELECT * FROM artist_verification_applications WHERE wallet_address=$1 ORDER BY created_at DESC LIMIT 1`,
      [id.wallet],
    );
    const latest = rows[0] || null;
    return { application: applicantApplicationDto(latest), canReapply: canApplicantReapply(latest?.status || null), reviewer };
  }

  async function submit({ request, input = {} }) {
    const id = await identity(request);
    const parsed = validateApplication(input);
    if (!parsed.ok) throw new ApiError(400, "INVALID_APPLICATION", "The application is incomplete or invalid.", parsed.errors);
    await bumpSubmitLimit(id.wallet);
    const live = await liveApplication(id.wallet);
    if (live && !canApplicantReapply(live.status)) {
      throw new ApiError(409, "APPLICATION_ALREADY_OPEN", "This wallet already has an open or verified artist verification application.");
    }
    const owned = await db.query(
      `SELECT a.id FROM artists a JOIN artist_owners ao ON ao.artist_id=a.id WHERE ao.owner_wallet=$1 ORDER BY a.created_at DESC LIMIT 1`,
      [id.wallet],
    );
    const artistId = owned.rows[0]?.id || null;
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      public_id: publicId(),
      wallet_address: id.wallet,
      artist_id: artistId,
      slug: parsed.value.slug || parsed.value.artistName.toLowerCase(),
      ...parsed.value,
    };
    const { rows } = await db.query(
      `INSERT INTO artist_verification_applications (
        id, public_id, wallet_address, artist_id, slug, artist_name, legal_name, email, location, artist_type,
        website_url, instagram_url, tiktok_url, youtube_url, spotify_url, apple_music_url, soundcloud_url, bandcamp_url, other_url,
        artist_bio, work_description, years_active, work_urls, portfolio_url, verification_evidence, additional_information,
        status, submitted_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,
        $20,$21,$22,$23::jsonb,$24,$25,$26,
        'SUBMITTED',$27
      ) RETURNING *`,
      [
        row.id, row.public_id, row.wallet_address, row.artist_id, row.slug, parsed.value.artistName, parsed.value.legalName, parsed.value.email, parsed.value.location, parsed.value.artistType,
        parsed.value.websiteUrl, parsed.value.instagramUrl, parsed.value.tiktokUrl, parsed.value.youtubeUrl, parsed.value.spotifyUrl, parsed.value.appleMusicUrl, parsed.value.soundcloudUrl, parsed.value.bandcampUrl, parsed.value.otherUrl,
        parsed.value.artistBio, parsed.value.workDescription, parsed.value.yearsActive, JSON.stringify(parsed.value.workUrls), parsed.value.portfolioUrl, parsed.value.verificationEvidence, parsed.value.additionalInformation,
        now,
      ],
    );
    await recordEvent({ applicationId: rows[0].id, fromStatus: null, toStatus: "SUBMITTED", actorWallet: id.wallet, actorRole: "APPLICANT" });
    logger.info?.("verification.submitted", { wallet: id.wallet, publicId: rows[0].public_id });
    return applicantApplicationDto(rows[0]);
  }

  async function respond({ request, publicId: idOrPublic, input = {} }) {
    const id = await identity(request);
    const { rows } = await db.query(`SELECT * FROM artist_verification_applications WHERE public_id=$1 AND wallet_address=$2 LIMIT 1`, [idOrPublic, id.wallet]);
    const row = rows[0];
    if (!row) throw new ApiError(404, "APPLICATION_NOT_FOUND", "Application was not found.");
    if (!canApplicantRespond(row.status)) throw new ApiError(409, "RESPONSE_NOT_ALLOWED", "Additional information can only be sent when a reviewer has requested it.");
    const response = String(input.applicantResponse || "").trim();
    if (!response) throw new ApiError(400, "RESPONSE_REQUIRED", "Enter a response for the reviewer.");
    const { rows: updated } = await db.query(
      `UPDATE artist_verification_applications SET applicant_response=$1, status='UNDER_REVIEW', updated_at=now() WHERE id=$2 RETURNING *`,
      [response.slice(0, 4000), row.id],
    );
    await recordEvent({ applicationId: row.id, fromStatus: row.status, toStatus: "UNDER_REVIEW", actorWallet: id.wallet, actorRole: "APPLICANT" });
    return applicantApplicationDto(updated[0]);
  }

  async function listVerified({ limit = 50, offset = 0 } = {}) {
    const { rows } = await db.query(
      `SELECT * FROM artist_verification_applications WHERE status='VERIFIED' ORDER BY reviewed_at DESC NULLS LAST LIMIT $1 OFFSET $2`,
      [Math.min(100, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0)],
    );
    return rows.map(publicApplicationDto);
  }

  async function listReviewQueue({ request, status } = {}) {
    await requireReviewer(request);
    const statuses = status && PENDING_REVIEW_STATUSES.includes(status) ? [status] : PENDING_REVIEW_STATUSES;
    const { rows } = await db.query(
      `SELECT * FROM artist_verification_applications WHERE status = ANY($1) ORDER BY submitted_at ASC NULLS LAST LIMIT 100`,
      [statuses],
    );
    return rows.map(reviewerApplicationDto);
  }

  async function getReviewApplication({ request, publicId: idOrPublic }) {
    await requireReviewer(request);
    const { rows } = await db.query(`SELECT * FROM artist_verification_applications WHERE public_id=$1 LIMIT 1`, [idOrPublic]);
    if (!rows[0]) throw new ApiError(404, "APPLICATION_NOT_FOUND", "Application was not found.");
    return reviewerApplicationDto(rows[0]);
  }

  async function decide({ request, publicId: idOrPublic, input = {} }) {
    const reviewer = await requireReviewer(request);
    const toStatus = String(input.status || "").toUpperCase();
    const { rows } = await db.query(`SELECT * FROM artist_verification_applications WHERE public_id=$1 LIMIT 1`, [idOrPublic]);
    const row = rows[0];
    if (!row) throw new ApiError(404, "APPLICATION_NOT_FOUND", "Application was not found.");
    if (!canReviewerTransition(row.status, toStatus)) throw new ApiError(409, "INVALID_TRANSITION", "That decision is not allowed from the current application state.");
    if (reviewerRequiresReason(toStatus) && !String(input.reason || "").trim()) {
      throw new ApiError(400, "REASON_REQUIRED", "A reason is required for this decision.");
    }
    const reason = String(input.reason || "").trim().slice(0, 4000) || null;
    const notes = String(input.notes || "").trim().slice(0, 4000) || null;
    const informationRequest = toStatus === "NEEDS_INFORMATION" ? reason : row.information_request;
    const { rows: updated } = await db.query(
      `UPDATE artist_verification_applications
       SET status=$1, reviewer_wallet=$2, review_notes=$3, decision_reason=$4, information_request=$5, reviewed_at=now(), updated_at=now()
       WHERE id=$6 RETURNING *`,
      [toStatus, reviewer.wallet, notes, reason, informationRequest, row.id],
    );
    await recordEvent({ applicationId: row.id, fromStatus: row.status, toStatus, actorWallet: reviewer.wallet, actorRole: "REVIEWER", reason });
    return reviewerApplicationDto(updated[0]);
  }

  async function verifiedFlagsForArtists(artistIds = []) {
    if (!artistIds.length) return new Map();
    const { rows } = await db.query(
      `SELECT artist_id, slug FROM artist_verification_applications WHERE status='VERIFIED' AND (artist_id = ANY($1) OR slug = ANY($1))`,
      [artistIds],
    );
    const flags = new Map();
    for (const row of rows) {
      if (row.artist_id) flags.set(row.artist_id, true);
      if (row.slug) flags.set(row.slug, true);
    }
    return flags;
  }

  return {
    getMine,
    submit,
    respond,
    listVerified,
    listReviewQueue,
    getReviewApplication,
    decide,
    isReviewer,
    verifiedFlagsForArtists,
  };
}
