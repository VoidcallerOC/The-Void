import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import process from "node:process";
import { ApiError } from "./api-errors.js";
import { requireWalletAuth } from "./api-runtime.js";
import { MAX_ARTWORK_BYTES, sniffArtwork } from "./artwork-storage.js";
import { validateMarketplaceArtwork } from "../src/lib/marketplace-presentation.js";

function parseAdminWallets(value) {
  return new Set(String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^0x[0-9a-f]{40}$/.test(entry)));
}

function presentationDto(row) {
  return { heroArtwork: row?.hero_artwork || null, updatedAt: row?.updated_at || null };
}

// Marketplace hero artwork: readable by anyone, writable only by wallets in
// MARKETPLACE_ADMIN_WALLETS. Unset means nobody can change it (fail closed).
export function createMarketplacePresentationService({ db, authenticator, artworkUploader = null, adminWallets = process.env.MARKETPLACE_ADMIN_WALLETS } = {}) {
  if (!db?.query || typeof authenticator !== "function") throw new TypeError("MarketplacePresentationService requires persistence and wallet authentication.");
  const admins = parseAdminWallets(adminWallets);

  async function requireAdmin(request) {
    const identity = await requireWalletAuth(authenticator, request);
    if (!admins.has(identity.wallet)) throw new ApiError(403, "MARKETPLACE_ADMIN_REQUIRED", "This wallet is not authorized to change the marketplace presentation.");
    return identity;
  }

  async function saveHero(identity, heroArtwork, extra = {}) {
    const { rows } = await db.query(
      `INSERT INTO marketplace_presentation (id, hero_artwork, updated_by, updated_at) VALUES (true, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET hero_artwork = EXCLUDED.hero_artwork, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING hero_artwork, updated_at`,
      [heroArtwork, identity.wallet],
    );
    await db.query(
      "INSERT INTO audit_events (event_type, actor_wallet, subject_type, subject_id, payload) VALUES ('MARKETPLACE_PRESENTATION_UPDATED', $1, 'marketplace', 'presentation', $2)",
      [identity.wallet, JSON.stringify({ heroArtwork, ...extra })],
    );
    return presentationDto(rows[0]);
  }

  return {
    async get() {
      const { rows } = await db.query("SELECT hero_artwork, updated_at FROM marketplace_presentation WHERE id = true");
      return presentationDto(rows[0]);
    },

    async getEditor({ request }) {
      const identity = await requireWalletAuth(authenticator, request);
      return { admin: admins.has(identity.wallet) };
    },

    async update({ request, input = {} }) {
      const identity = await requireAdmin(request);
      const checked = validateMarketplaceArtwork(input.heroArtwork);
      if (!checked.ok) throw new ApiError(400, "INVALID_MARKETPLACE_ARTWORK", checked.error);
      return saveHero(identity, checked.value);
    },

    // Upload an image file, pin it publicly, and make it the hero in one step.
    async uploadHero({ request, input = {} }) {
      const identity = await requireAdmin(request);
      if (typeof artworkUploader !== "function") throw new ApiError(503, "ARTWORK_UPLOAD_UNAVAILABLE", "Artwork upload is not configured.");
      const data = String(input.data ?? "");
      if (data.length > Math.ceil(MAX_ARTWORK_BYTES / 3) * 4 + 4) throw new ApiError(413, "ARTWORK_TOO_LARGE", "Artwork must be 3 MB or smaller.");
      const body = Buffer.from(data, "base64");
      if (!body.length) throw new ApiError(400, "ARTWORK_UPLOAD_EMPTY", "Artwork upload was empty.");
      if (body.length > MAX_ARTWORK_BYTES) throw new ApiError(413, "ARTWORK_TOO_LARGE", "Artwork must be 3 MB or smaller.");
      const image = sniffArtwork(body);
      if (!image) throw new ApiError(400, "ARTWORK_TYPE_UNSUPPORTED", "Artwork must be a PNG, JPEG, GIF or WebP image.");
      const contentSha256 = createHash("sha256").update(body).digest("hex");
      let stored;
      try {
        stored = await artworkUploader({ artistId: "marketplace", body, filename: `marketplace-hero-${contentSha256.slice(0, 16)}${image.extension}`, contentType: image.contentType });
      } catch (error) {
        throw new ApiError(error.status || 502, error.code || "ARTWORK_UPLOAD_FAILED", error.message || "Artwork upload failed.");
      }
      const checked = validateMarketplaceArtwork(stored?.uri);
      if (!checked.ok || !String(checked.value || "").startsWith("ipfs://")) throw new ApiError(502, "ARTWORK_UPLOAD_FAILED", "Artwork upload did not return an IPFS URI.");
      return saveHero(identity, checked.value, { contentSha256, byteSize: body.length, contentType: image.contentType });
    },
  };
}
