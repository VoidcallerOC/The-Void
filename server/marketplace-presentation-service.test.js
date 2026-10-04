import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarketplacePresentationService } from "./marketplace-presentation-service.js";
import { createLocalMarketplaceHeroStore } from "./marketplace-hero-storage.js";

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

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]).toString("base64");
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]).toString("base64");

function memoryHeroStore() {
  const files = new Map();
  return {
    files,
    async save({ body, filename, contentType }) {
      files.set(filename, { body, contentType });
      return { uri: `/assets/marketplace-heroes/${filename}` };
    },
    async read({ filename }) {
      const file = files.get(filename);
      if (!file) throw Object.assign(new Error("Marketplace hero file was not found."), { status: 404, code: "HERO_FILE_NOT_FOUND" });
      return { ...file, filename };
    },
  };
}

describe("marketplace hero upload", () => {
  it("lets an admin upload an image file and stores it as a local site file", async () => {
    const db = fakeDb();
    const heroStore = memoryHeroStore();
    const service = createMarketplacePresentationService({ db, authenticator, heroStore, adminWallets: ADMIN });
    const saved = await service.uploadHero({ request: as(ADMIN), input: { data: png } });
    expect(saved.heroArtwork).toMatch(/^\/assets\/marketplace-heroes\/marketplace-hero-[a-f0-9]{16}\.png$/);
    expect(heroStore.files.size).toBe(1);
    const [filename, stored] = [...heroStore.files.entries()][0];
    expect(stored.contentType).toBe("image/png");
    expect(saved.heroArtwork.endsWith(filename)).toBe(true);
    await expect(service.get()).resolves.toMatchObject({ heroArtwork: saved.heroArtwork });
    await expect(service.openHero({ filename })).resolves.toMatchObject({ contentType: "image/png", filename });
  });

  it("lets an admin replace the header with a different local file", async () => {
    const db = fakeDb();
    const heroStore = memoryHeroStore();
    const service = createMarketplacePresentationService({ db, authenticator, heroStore, adminWallets: ADMIN });
    const first = await service.uploadHero({ request: as(ADMIN), input: { data: png } });
    const second = await service.uploadHero({ request: as(ADMIN), input: { data: jpeg } });
    expect(second.heroArtwork).toMatch(/\.jpg$/);
    expect(second.heroArtwork).not.toBe(first.heroArtwork);
    expect(heroStore.files.size).toBe(2);
    await expect(service.get()).resolves.toMatchObject({ heroArtwork: second.heroArtwork });
  });

  it("refuses a non-admin upload before anything is written", async () => {
    const heroStore = memoryHeroStore();
    const service = createMarketplacePresentationService({ db: fakeDb(), authenticator, heroStore, adminWallets: ADMIN });
    await expect(service.uploadHero({ request: as(OTHER), input: { data: png } })).rejects.toMatchObject({ status: 403 });
    expect(heroStore.files.size).toBe(0);
  });

  it("rejects a file that is not an image", async () => {
    const heroStore = memoryHeroStore();
    const service = createMarketplacePresentationService({ db: fakeDb(), authenticator, heroStore, adminWallets: ADMIN });
    await expect(service.uploadHero({ request: as(ADMIN), input: { data: Buffer.from("not an image").toString("base64") } })).rejects.toMatchObject({ status: 400, code: "ARTWORK_TYPE_UNSUPPORTED" });
    expect(heroStore.files.size).toBe(0);
  });

  it("does not accept an IPFS URI from storage", async () => {
    const db = fakeDb();
    const heroStore = { async save() { return { uri: "ipfs://bafybeidedfcwz6qykwzqoqcs37zsqbjj3wpadyytee4didw2ocnur7veni" }; } };
    const service = createMarketplacePresentationService({ db, authenticator, heroStore, adminWallets: ADMIN });
    await expect(service.uploadHero({ request: as(ADMIN), input: { data: png } })).rejects.toMatchObject({ status: 502, code: "ARTWORK_UPLOAD_FAILED" });
    expect(db.state.row).toBeNull();
  });

  it("reports when uploads are not configured", async () => {
    const service = createMarketplacePresentationService({ db: fakeDb(), authenticator, adminWallets: ADMIN });
    await expect(service.uploadHero({ request: as(ADMIN), input: { data: png } })).rejects.toMatchObject({ status: 503 });
  });

  it("writes the image onto the local site directory and serves those bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "marketplace-hero-"));
    try {
      const db = fakeDb();
      const rows = new Map();
      db.query = async function query(sql, params = []) {
        if (sql.startsWith("SELECT hero_artwork")) return { rows: db.state.row ? [db.state.row] : [] };
        if (sql.includes("INSERT INTO marketplace_presentation")) {
          db.state.row = { hero_artwork: params[0], updated_by: params[1], updated_at: "2026-10-03T00:00:00Z" };
          return { rows: [db.state.row] };
        }
        if (sql.includes("INSERT INTO audit_events")) { db.state.audits.push(params); return { rows: [] }; }
        if (sql.includes("INSERT INTO marketplace_hero_files")) {
          rows.set(params[0], { content_type: params[1], body: params[3] });
          return { rows: [] };
        }
        if (sql.includes("FROM marketplace_hero_files")) {
          const row = rows.get(params[0]);
          return { rows: row ? [row] : [] };
        }
        throw new Error(`unexpected query ${sql}`);
      };
      const heroStore = createLocalMarketplaceHeroStore({ root, db });
      const service = createMarketplacePresentationService({ db, authenticator, heroStore, adminWallets: ADMIN });
      const saved = await service.uploadHero({ request: as(ADMIN), input: { data: png } });
      const filename = saved.heroArtwork.split("/").pop();
      const opened = await service.openHero({ filename });
      expect(opened.body.subarray(0, 4).toString("hex")).toBe("89504e47");
      expect(opened.contentType).toBe("image/png");
      await expect(service.openHero({ filename: "../secrets.png" })).rejects.toMatchObject({ status: 400, code: "HERO_FILE_INVALID" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
