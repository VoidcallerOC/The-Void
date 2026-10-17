import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalArtistPortfolioStore } from "./artist-portfolio-storage.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const filename = "artist-portfolio-0123456789abcdef.png";

// A root whose parent is a regular file: mkdir(root, { recursive }) raises an
// ENOTDIR error, standing in for the EACCES a read-only production container
// (/app/public) raises without needing a real read-only mount.
async function unwritableRoot() {
  const base = await mkdtemp(join(tmpdir(), "portfolio-unwritable-"));
  const file = join(base, "not-a-dir");
  await writeFile(file, "x");
  return { root: join(file, "assets", "artist-portfolio"), cleanup: () => rm(base, { recursive: true, force: true }) };
}

function memoryDb() {
  const rows = new Map();
  return {
    rows,
    query: vi.fn(async (sql, params = []) => {
      if (String(sql).includes("INSERT INTO artist_portfolio_files")) {
        rows.set(params[0], { content_type: params[1], byte_size: params[2], body: params[3] });
        return { rows: [] };
      }
      if (String(sql).includes("FROM artist_portfolio_files")) {
        const row = rows.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    }),
  };
}

describe("artist portfolio storage", () => {
  it("requires a directory", () => {
    expect(() => createLocalArtistPortfolioStore({})).toThrow(/directory/);
  });

  it("rejects an unsupported image type before any write", async () => {
    const db = memoryDb();
    const store = createLocalArtistPortfolioStore({ root: join(tmpdir(), "unused"), db });
    await expect(store.save({ body: png, filename: "artist-portfolio-0123456789abcdef.svg", contentType: "image/svg+xml" }))
      .rejects.toMatchObject({ status: 400, code: "PORTFOLIO_FILE_INVALID" });
    await expect(store.save({ body: png, filename, contentType: "image/jpeg" }))
      .rejects.toMatchObject({ status: 400, code: "ARTWORK_TYPE_UNSUPPORTED" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects path traversal in the filename", async () => {
    const store = createLocalArtistPortfolioStore({ root: join(tmpdir(), "unused"), db: memoryDb() });
    await expect(store.read({ filename: "../secrets.png" })).rejects.toMatchObject({ status: 400, code: "PORTFOLIO_FILE_INVALID" });
  });

  it("persists to the database and serves the bytes back after a fetch (survives a redeploy)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "portfolio-"));
    try {
      const db = memoryDb();
      const store = createLocalArtistPortfolioStore({ root: directory, db });
      const saved = await store.save({ body: png, filename, contentType: "image/png" });
      expect(saved.uri).toBe(`/assets/artist-portfolio/${filename}`);
      expect(db.rows.get(filename).body.equals(png)).toBe(true);

      // A fresh store with the same database but an EMPTY directory (a redeploy
      // with an ephemeral filesystem) still serves the durable bytes.
      const afterRedeploy = createLocalArtistPortfolioStore({ root: await mkdtemp(join(tmpdir(), "portfolio-empty-")), db });
      const read = await afterRedeploy.read({ filename });
      expect(read.body.equals(png)).toBe(true);
      expect(read.contentType).toBe("image/png");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("succeeds without writing to /app/public when the filesystem is read-only but a database copy is durable", async () => {
    const { root, cleanup } = await unwritableRoot();
    try {
      const db = memoryDb();
      const logger = { warn: vi.fn() };
      const store = createLocalArtistPortfolioStore({ root, db, logger });
      const saved = await store.save({ body: png, filename, contentType: "image/png" });
      // Durable copy exists and the upload does not fail on the read-only path.
      expect(saved.uri).toBe(`/assets/artist-portfolio/${filename}`);
      expect(db.rows.get(filename).body.equals(png)).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith("artist.portfolio.cache_write_failed", expect.objectContaining({ filename }));
      // And the bytes are still retrievable from the durable store.
      expect((await store.read({ filename })).body.equals(png)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("surfaces a database write failure instead of falsely reporting success", async () => {
    const directory = await mkdtemp(join(tmpdir(), "portfolio-"));
    try {
      const db = { query: vi.fn(async () => { throw Object.assign(new Error("db down"), { code: "57P01" }); }) };
      const store = createLocalArtistPortfolioStore({ root: directory, db });
      await expect(store.save({ body: png, filename, contentType: "image/png" })).rejects.toThrow("db down");
      // Nothing was written to the local cache either.
      await expect(readFile(join(directory, filename))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails with a controlled, path-free error when no database is configured and the filesystem is unwritable", async () => {
    const { root, cleanup } = await unwritableRoot();
    try {
      const store = createLocalArtistPortfolioStore({ root });
      const error = await store.save({ body: png, filename, contentType: "image/png" }).catch((caught) => caught);
      expect(error).toMatchObject({ status: 503, code: "PORTFOLIO_STORAGE_UNAVAILABLE" });
      // The sanitized message must not leak the attempted filesystem path.
      expect(error.message).not.toMatch(/public|mkdir|EACCES|ENOTDIR|\//);
    } finally {
      await cleanup();
    }
  });
});
