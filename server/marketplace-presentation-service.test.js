import { Buffer } from "node:buffer";
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

const CID_URI = "ipfs://bafybeidedfcwz6qykwzqoqcs37zsqbjj3wpadyytee4didw2ocnur7veni";
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]).toString("base64");

describe("marketplace hero upload", () => {
  it("lets an admin upload an image file and makes it the hero", async () => {
    const db = fakeDb();
    const calls = [];
    const artworkUploader = async (args) => { calls.push(args); return { uri: CID_URI }; };
    const service = createMarketplacePresentationService({ db, authenticator, artworkUploader, adminWallets: ADMIN });
    await expect(service.uploadHero({ request: as(ADMIN), input: { data: png } })).resolves.toMatchObject({ heroArtwork: CID_URI });
    expect(calls[0]).toMatchObject({ contentType: "image/png" });
    await expect(service.get()).resolves.toMatchObject({ heroArtwork: CID_URI });
  });

  it("refuses a non-admin upload before anything is pinned", async () => {
    let called = false;
    const service = createMarketplacePresentationService({ db: fakeDb(), authenticator, artworkUploader: async () => { called = true; return { uri: CID_URI }; }, adminWallets: ADMIN });
    await expect(service.uploadHero({ request: as(OTHER), input: { data: png } })).rejects.toMatchObject({ status: 403 });
    expect(called).toBe(false);
  });

  it("rejects a file that is not an image", async () => {
    const service = createMarketplacePresentationService({ db: fakeDb(), authenticator, artworkUploader: async () => ({ uri: CID_URI }), adminWallets: ADMIN });
    await expect(service.uploadHero({ request: as(ADMIN), input: { data: Buffer.from("not an image").toString("base64") } })).rejects.toMatchObject({ status: 400, code: "ARTWORK_TYPE_UNSUPPORTED" });
  });

  it("reports when uploads are not configured", async () => {
    const service = createMarketplacePresentationService({ db: fakeDb(), authenticator, adminWallets: ADMIN });
    await expect(service.uploadHero({ request: as(ADMIN), input: { data: png } })).rejects.toMatchObject({ status: 503 });
  });
});

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
