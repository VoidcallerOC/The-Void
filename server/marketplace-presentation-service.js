import process from "node:process";
import { ApiError } from "./api-errors.js";
import { requireWalletAuth } from "./api-runtime.js";
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
export function createMarketplacePresentationService({ db, authenticator, adminWallets = process.env.MARKETPLACE_ADMIN_WALLETS } = {}) {
  if (!db?.query || typeof authenticator !== "function") throw new TypeError("MarketplacePresentationService requires persistence and wallet authentication.");
  const admins = parseAdminWallets(adminWallets);

  async function requireAdmin(request) {
    const identity = await requireWalletAuth(authenticator, request);
    if (!admins.has(identity.wallet)) throw new ApiError(403, "MARKETPLACE_ADMIN_REQUIRED", "This wallet is not authorized to change the marketplace presentation.");
    return identity;
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
      const { rows } = await db.query(
        `INSERT INTO marketplace_presentation (id, hero_artwork, updated_by, updated_at) VALUES (true, $1, $2, now())
         ON CONFLICT (id) DO UPDATE SET hero_artwork = EXCLUDED.hero_artwork, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING hero_artwork, updated_at`,
        [checked.value, identity.wallet],
      );
      await db.query(
        "INSERT INTO audit_events (event_type, actor_wallet, subject_type, subject_id, payload) VALUES ('MARKETPLACE_PRESENTATION_UPDATED', $1, 'marketplace', 'presentation', $2)",
        [identity.wallet, JSON.stringify({ heroArtwork: checked.value })],
      );
      return presentationDto(rows[0]);
    },
  };
}
