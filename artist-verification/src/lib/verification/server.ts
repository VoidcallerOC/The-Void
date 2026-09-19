import { randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { getSql } from "@/lib/db";
import {
  parseWorkUrls,
  toApplicantApplication,
  toPublicArtist,
  toReviewerApplication,
  type ApplicationRow,
  type ProfileRow,
} from "./dto";
import { publicErrorMessage, VerificationError } from "./errors";
import {
  canApplicantReapply,
  canApplicantRespond,
  canReviewerTransition,
  profileStatusFromApplication,
  reviewerRequiresReason,
} from "./status";
import type {
  ApplicationInput,
  ApplicationStatus,
  DashboardState,
  PublicArtist,
  ReviewerApplication,
} from "./types";
import { APPLICATION_STATUSES } from "./types";
import { makePublicId, slugify, validateApplication } from "./validate";

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: ReturnType<typeof publicErrorMessage> };
type Result<T> = Ok<T> | Err;

function ok<T>(data: T): Ok<T> {
  return { ok: true, data };
}

function fail(error: unknown): Err {
  return { ok: false, error: publicErrorMessage(error) };
}

function isStatus(value: string): value is ApplicationStatus {
  return (APPLICATION_STATUSES as readonly string[]).includes(value);
}

async function isReviewer(userId: string): Promise<boolean> {
  const sql = await getSql();
  const rows = await sql<{ user_id: string }>`
    select user_id from verification_reviewers where user_id = ${userId} limit 1
  `;
  return rows.length > 0;
}

async function reviewerCount(): Promise<number> {
  const sql = await getSql();
  const rows = await sql<{ n: number }>`select count(*)::int as n from verification_reviewers`;
  return rows[0]?.n ?? 0;
}

async function requireReviewer(userId: string): Promise<void> {
  if (!(await isReviewer(userId))) {
    throw new VerificationError("FORBIDDEN", "Reviewer authorization is required.", 403);
  }
}

async function assertRateLimit(userId: string, action: string, max: number): Promise<void> {
  const sql = await getSql();
  const windowStart = new Date();
  windowStart.setUTCMinutes(0, 0, 0);
  windowStart.setUTCSeconds(0);
  windowStart.setUTCMilliseconds(0);
  const stamp = windowStart.toISOString();
  await sql`
    insert into verification_rate_limits (user_id, action, window_start, count)
    values (${userId}, ${action}, ${stamp}, 1)
    on conflict (user_id, action, window_start)
    do update set count = verification_rate_limits.count + 1
  `;
  const rows = await sql<{ count: number }>`
    select count from verification_rate_limits
    where user_id = ${userId} and action = ${action} and window_start = ${stamp}
  `;
  if ((rows[0]?.count ?? 0) > max) {
    throw new VerificationError(
      "RATE_LIMITED",
      "Too many attempts. Wait before trying again.",
      429,
    );
  }
}

async function uniqueSlug(base: string, excludeId?: string): Promise<string> {
  const sql = await getSql();
  const root = slugify(base);
  for (let i = 0; i < 20; i += 1) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const rows = excludeId
      ? await sql<{ id: string }>`select id from artist_profiles where slug = ${candidate} and id <> ${excludeId} limit 1`
      : await sql<{ id: string }>`select id from artist_profiles where slug = ${candidate} limit 1`;
    if (!rows.length) return candidate;
  }
  return `${root}-${randomUUID().slice(0, 8)}`;
}

async function recordEvent(opts: {
  applicationId: string;
  from: ApplicationStatus | null;
  to: ApplicationStatus;
  actorId: string;
  role: "APPLICANT" | "REVIEWER" | "SYSTEM";
  reason?: string | null;
}): Promise<void> {
  const sql = await getSql();
  await sql`
    insert into verification_status_events (id, application_id, from_status, to_status, actor_id, actor_role, reason)
    values (${randomUUID()}, ${opts.applicationId}, ${opts.from}, ${opts.to}, ${opts.actorId}, ${opts.role}, ${opts.reason ?? null})
  `;
}

async function syncProfileFromApplication(profileId: string, status: ApplicationStatus): Promise<void> {
  const sql = await getSql();
  const next = profileStatusFromApplication(status);
  const verifiedAt = status === "VERIFIED" ? new Date().toISOString() : null;
  if (status === "VERIFIED") {
    await sql`
      update artist_profiles
      set verification_status = ${next}, verified_at = ${verifiedAt}, updated_at = now()
      where id = ${profileId}
    `;
    return;
  }
  await sql`
    update artist_profiles
    set verification_status = ${next}, updated_at = now()
    where id = ${profileId}
  `;
}

async function latestApplicationForUser(userId: string): Promise<ApplicationRow | null> {
  const sql = await getSql();
  const rows = await sql<ApplicationRow>`
    select * from artist_verification_applications
    where user_id = ${userId}
    order by created_at desc
    limit 1
  `;
  return rows[0] ?? null;
}

async function profileForUser(userId: string): Promise<ProfileRow | null> {
  const sql = await getSql();
  const rows = await sql<ProfileRow>`
    select * from artist_profiles where user_id = ${userId} limit 1
  `;
  return rows[0] ?? null;
}

export const getDashboard = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Result<DashboardState>> => {
    try {
      const application = await latestApplicationForUser(context.userId);
      const profile = await profileForUser(context.userId);
      const reviewer = await isReviewer(context.userId);
      const count = await reviewerCount();
      return ok({
        userId: context.userId,
        isReviewer: reviewer,
        canClaimReviewerSeat: !reviewer && count === 0,
        profile: profile ? toPublicArtist(profile) : null,
        application: application ? toApplicantApplication(application) : null,
      });
    } catch (error) {
      return fail(error);
    }
  });

export const submitApplication = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: ApplicationInput) => data)
  .handler(async ({ context, data }): Promise<Result<{ application: ReturnType<typeof toApplicantApplication>; slug: string }>> => {
    try {
      const parsed = validateApplication(data);
      if (!parsed.ok) {
        throw new VerificationError("VALIDATION", "Please correct the highlighted fields.", 400, parsed.errors);
      }
      await assertRateLimit(context.userId, "submit", 5);

      const existing = await latestApplicationForUser(context.userId);
      if (existing && !canApplicantReapply(existing.status)) {
        throw new VerificationError(
          "DUPLICATE",
          existing.status === "VERIFIED"
            ? "This account already holds a verified artist identity."
            : "An application for this account is already in progress.",
          409,
        );
      }

      const sql = await getSql();
      const now = new Date().toISOString();
      const value = parsed.value;
      let profile = await profileForUser(context.userId);
      const slug = await uniqueSlug(value.artistName, profile?.id);
      const workJson = JSON.stringify(value.workUrls);

      if (profile) {
        await sql`
          update artist_profiles set
            slug = ${slug},
            artist_name = ${value.artistName},
            legal_name = ${value.legalName},
            email = ${value.email},
            location = ${value.location},
            artist_type = ${value.artistType},
            artist_bio = ${value.artistBio},
            work_description = ${value.workDescription},
            years_active = ${value.yearsActive},
            website_url = ${value.websiteUrl},
            instagram_url = ${value.instagramUrl},
            tiktok_url = ${value.tiktokUrl},
            youtube_url = ${value.youtubeUrl},
            spotify_url = ${value.spotifyUrl},
            apple_music_url = ${value.appleMusicUrl},
            soundcloud_url = ${value.soundcloudUrl},
            bandcamp_url = ${value.bandcampUrl},
            other_url = ${value.otherUrl},
            portfolio_url = ${value.portfolioUrl},
            work_urls_json = ${workJson},
            verification_status = ${"PENDING"},
            updated_at = ${now}
          where id = ${profile.id} and user_id = ${context.userId}
        `;
      } else {
        const profileId = randomUUID();
        await sql`
          insert into artist_profiles (
            id, user_id, slug, artist_name, legal_name, email, location, artist_type,
            artist_bio, work_description, years_active, website_url, instagram_url,
            tiktok_url, youtube_url, spotify_url, apple_music_url, soundcloud_url,
            bandcamp_url, other_url, portfolio_url, work_urls_json, verification_status, updated_at
          ) values (
            ${profileId}, ${context.userId}, ${slug}, ${value.artistName}, ${value.legalName},
            ${value.email}, ${value.location}, ${value.artistType}, ${value.artistBio},
            ${value.workDescription}, ${value.yearsActive}, ${value.websiteUrl}, ${value.instagramUrl},
            ${value.tiktokUrl}, ${value.youtubeUrl}, ${value.spotifyUrl}, ${value.appleMusicUrl},
            ${value.soundcloudUrl}, ${value.bandcampUrl}, ${value.otherUrl}, ${value.portfolioUrl},
            ${workJson}, ${"PENDING"}, ${now}
          )
        `;
        profile = { id: profileId } as ProfileRow;
      }

      const refreshed = await profileForUser(context.userId);
      if (!refreshed) throw new VerificationError("UNAVAILABLE", "The application could not be stored.", 503);

      const id = randomUUID();
      const publicId = makePublicId(id);
      try {
        await sql`
          insert into artist_verification_applications (
            id, public_id, user_id, artist_profile_id, artist_name, legal_name, email, location,
            artist_type, website_url, instagram_url, tiktok_url, youtube_url, spotify_url,
            apple_music_url, soundcloud_url, bandcamp_url, other_url, artist_bio, work_description,
            years_active, work_urls_json, portfolio_url, verification_evidence, additional_information,
            status, submitted_at, updated_at
          ) values (
            ${id}, ${publicId}, ${context.userId}, ${refreshed.id}, ${value.artistName}, ${value.legalName},
            ${value.email}, ${value.location}, ${value.artistType}, ${value.websiteUrl}, ${value.instagramUrl},
            ${value.tiktokUrl}, ${value.youtubeUrl}, ${value.spotifyUrl}, ${value.appleMusicUrl},
            ${value.soundcloudUrl}, ${value.bandcampUrl}, ${value.otherUrl}, ${value.artistBio},
            ${value.workDescription}, ${value.yearsActive}, ${workJson}, ${value.portfolioUrl},
            ${value.verificationEvidence}, ${value.additionalInformation}, ${"SUBMITTED"}, ${now}, ${now}
          )
        `;
      } catch (error) {
        const code = typeof error === "object" && error && "code" in error ? String((error as { code?: string }).code) : "";
        if (code === "23505") {
          throw new VerificationError("DUPLICATE", "An application for this account is already in progress.", 409);
        }
        throw error;
      }

      await recordEvent({
        applicationId: id,
        from: existing?.status ?? null,
        to: "SUBMITTED",
        actorId: context.userId,
        role: "APPLICANT",
      });

      const stored = await sql<ApplicationRow>`select * from artist_verification_applications where id = ${id} limit 1`;
      const row = stored[0];
      if (!row) throw new VerificationError("UNAVAILABLE", "The application could not be stored.", 503);
      return ok({ application: toApplicantApplication(row), slug: refreshed.slug });
    } catch (error) {
      return fail(error);
    }
  });

export const respondToInformationRequest = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: { applicationId: string; response: string }) => data)
  .handler(async ({ context, data }): Promise<Result<{ application: ReturnType<typeof toApplicantApplication> }>> => {
    try {
      await assertRateLimit(context.userId, "respond", 10);
      const sql = await getSql();
      const rows = await sql<ApplicationRow>`
        select * from artist_verification_applications
        where id = ${data.applicationId} and user_id = ${context.userId}
        limit 1
      `;
      const row = rows[0];
      if (!row) throw new VerificationError("NOT_FOUND", "Application not found.", 404);
      if (!canApplicantRespond(row.status)) {
        throw new VerificationError("INVALID_TRANSITION", "This application is not waiting for additional information.", 409);
      }
      const response = (data.response || "").trim().slice(0, 4000);
      if (response.length < 8) {
        throw new VerificationError("VALIDATION", "Enter the additional information requested.", 400, {
          response: "Enter the additional information requested.",
        });
      }
      const now = new Date().toISOString();
      await sql`
        update artist_verification_applications
        set applicant_response = ${response},
            status = ${"SUBMITTED"},
            updated_at = ${now}
        where id = ${row.id} and user_id = ${context.userId} and status = ${"NEEDS_INFORMATION"}
      `;
      await recordEvent({
        applicationId: row.id,
        from: "NEEDS_INFORMATION",
        to: "SUBMITTED",
        actorId: context.userId,
        role: "APPLICANT",
        reason: response,
      });
      const next = await sql<ApplicationRow>`select * from artist_verification_applications where id = ${row.id} limit 1`;
      if (!next[0]) throw new VerificationError("UNAVAILABLE", "The response could not be stored.", 503);
      return ok({ application: toApplicantApplication(next[0]) });
    } catch (error) {
      return fail(error);
    }
  });

export const claimReviewerSeat = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Result<{ isReviewer: boolean }>> => {
    try {
      await assertRateLimit(context.userId, "claim-reviewer", 5);
      const sql = await getSql();
      const count = await reviewerCount();
      if (count === 0) {
        await sql`
          insert into verification_reviewers (user_id, granted_by)
          values (${context.userId}, ${context.userId})
          on conflict (user_id) do nothing
        `;
        return ok({ isReviewer: true });
      }
      if (await isReviewer(context.userId)) return ok({ isReviewer: true });
      throw new VerificationError("FORBIDDEN", "Reviewer authorization is required.", 403);
    } catch (error) {
      return fail(error);
    }
  });

export const listReviewQueue = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Result<{ applications: ReviewerApplication[]; canClaim: boolean; isReviewer: boolean }>> => {
    try {
      const count = await reviewerCount();
      const reviewer = await isReviewer(context.userId);
      if (!reviewer) {
        return ok({ applications: [], canClaim: count === 0, isReviewer: false });
      }
      const sql = await getSql();
      const rows = await sql<(ApplicationRow & { slug: string })>`
        select a.*, p.slug
        from artist_verification_applications a
        join artist_profiles p on p.id = a.artist_profile_id
        order by a.submitted_at desc nulls last, a.created_at desc
      `;
      return ok({
        applications: rows.map((row) => toReviewerApplication(row, row.slug)),
        canClaim: false,
        isReviewer: true,
      });
    } catch (error) {
      return fail(error);
    }
  });

export const getReviewApplication = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .validator((data: { id: string }) => data)
  .handler(async ({ context, data }): Promise<Result<{ application: ReviewerApplication }>> => {
    try {
      await requireReviewer(context.userId);
      const sql = await getSql();
      const rows = await sql<(ApplicationRow & { slug: string })>`
        select a.*, p.slug
        from artist_verification_applications a
        join artist_profiles p on p.id = a.artist_profile_id
        where a.id = ${data.id}
        limit 1
      `;
      const row = rows[0];
      if (!row) throw new VerificationError("NOT_FOUND", "Application not found.", 404);
      return ok({ application: toReviewerApplication(row, row.slug) });
    } catch (error) {
      return fail(error);
    }
  });

export const reviewApplication = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((data: {
    applicationId: string;
    status: string;
    reviewNotes?: string;
    decisionReason?: string;
    informationRequest?: string;
  }) => data)
  .handler(async ({ context, data }): Promise<Result<{ application: ReviewerApplication }>> => {
    try {
      await requireReviewer(context.userId);
      await assertRateLimit(context.userId, "review", 40);
      if (!isStatus(data.status)) {
        throw new VerificationError("VALIDATION", "Invalid application status.", 400);
      }
      const sql = await getSql();
      const rows = await sql<(ApplicationRow & { slug: string })>`
        select a.*, p.slug
        from artist_verification_applications a
        join artist_profiles p on p.id = a.artist_profile_id
        where a.id = ${data.applicationId}
        limit 1
      `;
      const row = rows[0];
      if (!row) throw new VerificationError("NOT_FOUND", "Application not found.", 404);
      if (!canReviewerTransition(row.status, data.status)) {
        throw new VerificationError("INVALID_TRANSITION", "That status change is not allowed.", 409);
      }
      const reason = (data.decisionReason || "").trim().slice(0, 2000) || null;
      const request = (data.informationRequest || "").trim().slice(0, 2000) || null;
      const notes = (data.reviewNotes || "").trim().slice(0, 4000) || null;
      if (reviewerRequiresReason(data.status) && !(reason || request)) {
        throw new VerificationError(
          "VALIDATION",
          data.status === "NEEDS_INFORMATION"
            ? "Describe the additional information required."
            : "Provide a decision reason.",
          400,
        );
      }

      const now = new Date().toISOString();
      await sql`
        update artist_verification_applications
        set status = ${data.status},
            reviewer_id = ${context.userId},
            review_notes = ${notes ?? row.review_notes},
            decision_reason = ${data.status === "NEEDS_INFORMATION" ? row.decision_reason : reason},
            information_request = ${data.status === "NEEDS_INFORMATION" ? request : row.information_request},
            reviewed_at = ${now},
            updated_at = ${now}
        where id = ${row.id}
      `;
      await syncProfileFromApplication(row.artist_profile_id, data.status);
      await recordEvent({
        applicationId: row.id,
        from: row.status,
        to: data.status,
        actorId: context.userId,
        role: "REVIEWER",
        reason: reason ?? request,
      });
      const next = await sql<(ApplicationRow & { slug: string })>`
        select a.*, p.slug
        from artist_verification_applications a
        join artist_profiles p on p.id = a.artist_profile_id
        where a.id = ${row.id}
        limit 1
      `;
      if (!next[0]) throw new VerificationError("UNAVAILABLE", "The decision could not be stored.", 503);
      return ok({ application: toReviewerApplication(next[0], next[0].slug) });
    } catch (error) {
      return fail(error);
    }
  });

export const listVerifiedArtists = createServerFn({ method: "GET" }).handler(
  async (): Promise<Result<{ artists: PublicArtist[] }>> => {
    try {
      const sql = await getSql();
      const rows = await sql<ProfileRow>`
        select * from artist_profiles
        where verification_status = ${"VERIFIED"}
        order by artist_name asc
      `;
      return ok({ artists: rows.map(toPublicArtist) });
    } catch (error) {
      return fail(error);
    }
  },
);

export const getPublicArtist = createServerFn({ method: "GET" })
  .validator((data: { slug: string }) => data)
  .handler(async ({ data }): Promise<Result<{ artist: PublicArtist }>> => {
    try {
      const slug = (data.slug || "").trim().toLowerCase().slice(0, 64);
      if (!slug) throw new VerificationError("NOT_FOUND", "Artist not found.", 404);
      const sql = await getSql();
      const rows = await sql<ProfileRow>`
        select * from artist_profiles
        where slug = ${slug} and verification_status = ${"VERIFIED"}
        limit 1
      `;
      const row = rows[0];
      if (!row) throw new VerificationError("NOT_FOUND", "Artist not found.", 404);
      return ok({ artist: toPublicArtist(row) });
    } catch (error) {
      return fail(error);
    }
  });

export const getMyApplication = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<Result<{ application: ReturnType<typeof toApplicantApplication> }>> => {
    try {
      const row = await latestApplicationForUser(context.userId);
      if (!row) throw new VerificationError("NOT_FOUND", "No application found for this account.", 404);
      return ok({ application: toApplicantApplication(row) });
    } catch (error) {
      return fail(error);
    }
  });
