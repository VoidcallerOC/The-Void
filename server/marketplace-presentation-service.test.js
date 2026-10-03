import { describe, expect, it } from "vitest";
import { createMarketplacePresentationService } from "./marketplace-presentation-service.js";

const ADMIN = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const OTHER = "0x6a86efa012feda64b70112022487fee22e67d2fb";

function fakeDb() {
  const state = { row: null, audits: [] };
  return {
    state,
    async query(sql, params = []) {
      if (sql.startsWith("SELECT")) return { rows: state.row ? [state.row] : [] };
      if (sql.includes("INSERT INTO marketplace_presentation")) {
        state.row = { hero_artwork: params[0], updated_by: params[1], updated_at: "2026-10-03T00:00:00Z" };
        return { rows: [state.row] };
      }
      if (sql.includes("INSERT INTO audit_events")) { state.audits.push(params); return { rows: [] }; }
      throw new Error(`unexpected query ${sql}`);
    },
  };
}

const authenticator = async (request) => (request.headers.wallet ? { wallet: request.headers.wallet } : null);
const as = (wallet) => ({ headers: wallet ? { wallet } : {} });

describe("marketplace presentation service", () => {
  it("is unconfigured by default", async () => {
    const service = createMarketplacePresentationService({ db: fakeDb(), authenticator, adminWallets: ADMIN });
    await expect(service.get()).resolves.toEqual({ heroArtwork: null, updatedAt: null });
  });

  it("lets a listed admin set the artwork and persists it", async () => {
    const db = fakeDb();
    const service = createMarketplacePresentationService({ db, authenticator, adminWallets: ADMIN.toUpperCase().replace("0X", "0x") });
    await service.update({ request: as(ADMIN), input: { heroArtwork: "/assets/voidcaller_art_6.png" } });
    await expect(service.get()).resolves.toMatchObject({ heroArtwork: "/assets/voidcaller_art_6.png" });
    expect(db.state.row.updated_by).toBe(ADMIN);
    expect(db.state.audits).toHaveLength(1);
  });

  it("rejects a non-admin wallet server-side", async () => {
    const db = fakeDb();
    const service = createMarketplacePresentationService({ db, authenticator, adminWallets: ADMIN });
    await expect(service.update({ request: as(OTHER), input: { heroArtwork: "/assets/voidcaller_art_6.png" } })).rejects.toMatchObject({ status: 403, code: "MARKETPLACE_ADMIN_REQUIRED" });
    expect(db.state.row).toBeNull();
  });

  it("rejects an unauthenticated request", async () => {
    const service = createMarketplacePresentationService({ db: fakeDb(), authenticator, adminWallets: ADMIN });
    await expect(service.update({ request: as(null), input: { heroArtwork: "/assets/a.png" } })).rejects.toMatchObject({ status: 401 });
  });

  it("fails closed when no admin wallets are configured", async () => {
    const service = createMarketplacePresentationService({ db: fakeDb(), authenticator, adminWallets: "" });
    await expect(service.update({ request: as(ADMIN), input: { heroArtwork: "/assets/a.png" } })).rejects.toMatchObject({ status: 403 });
    await expect(service.getEditor({ request: as(ADMIN) })).resolves.toEqual({ admin: false });
  });

  it("rejects an unsafe artwork reference", async () => {
    const service = createMarketplacePresentationService({ db: fakeDb(), authenticator, adminWallets: ADMIN });
    await expect(service.update({ request: as(ADMIN), input: { heroArtwork: "javascript:alert(1)" } })).rejects.toMatchObject({ status: 400, code: "INVALID_MARKETPLACE_ARTWORK" });
  });
});
