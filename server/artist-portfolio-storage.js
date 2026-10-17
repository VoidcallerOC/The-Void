import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

// Content-addressed names only. Replacing a profile picture or banner writes a
// new file and points the profile at it. Old files stay (nothing is deleted
// from Pinata or from this directory).
const FILENAME = /^artist-portfolio-[a-f0-9]{16}\.(png|jpg|gif|webp)$/;
const CONTENT_TYPES = Object.freeze({ png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" });

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function artistPortfolioFilename(filename) {
  const name = String(filename || "");
  if (!FILENAME.test(name)) throw fail(400, "PORTFOLIO_FILE_INVALID", "Artist portfolio filename is invalid.");
  return name;
}

export function createLocalArtistPortfolioStore({ root, db = null, logger = null } = {}) {
  if (!root) throw new TypeError("Artist portfolio storage requires a directory.");
  const directory = resolve(root);
  // The database (artist_portfolio_files) is the durable store in production.
  // The directory under public/assets is only a serving cache for local dev; a
  // production container mounts it read-only (writes to /app/public raise EACCES),
  // so it can never be required when a durable database copy exists.
  const hasDatabase = typeof db?.query === "function";

  function filePath(name) {
    const path = resolve(directory, name);
    if (path !== directory && !path.startsWith(`${directory}${sep}`)) throw fail(400, "PORTFOLIO_FILE_INVALID", "Artist portfolio path is invalid.");
    return path;
  }

  return {
    // Writes the durable copy to the database, then best-effort mirrors it to
    // the local cache directory. With a database configured, a read-only or
    // ephemeral filesystem (production) no longer fails the upload. Without a
    // database there is no durable store, so a filesystem failure is reported
    // as a controlled error rather than leaking the attempted path.
    async save({ body, filename, contentType }) {
      const name = artistPortfolioFilename(filename);
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
      if (!bytes.length) throw fail(400, "ARTWORK_UPLOAD_EMPTY", "Artwork upload was empty.");
      if (!CONTENT_TYPES[name.split(".").pop()] || CONTENT_TYPES[name.split(".").pop()] !== contentType) {
        throw fail(400, "ARTWORK_TYPE_UNSUPPORTED", "Artwork must be a PNG, JPEG, GIF or WebP image.");
      }
      if (hasDatabase) {
        await db.query(
          `INSERT INTO artist_portfolio_files (filename, content_type, byte_size, body)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (filename) DO UPDATE SET content_type = EXCLUDED.content_type, byte_size = EXCLUDED.byte_size, body = EXCLUDED.body`,
          [name, contentType, bytes.length, bytes],
        );
      }
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(filePath(name), bytes);
      } catch (error) {
        // No durable database copy exists: do not report success, and do not
        // leak the filesystem path (e.g. EACCES mkdir '/app/public').
        if (!hasDatabase) throw fail(503, "PORTFOLIO_STORAGE_UNAVAILABLE", "Artist portfolio storage is not configured for persistence.");
        // The durable database copy already succeeded; the local cache is
        // optional, so a read-only/ephemeral filesystem is not a failure.
        logger?.warn?.("artist.portfolio.cache_write_failed", { filename: name, code: error?.code || null });
      }
      return { uri: `/assets/artist-portfolio/${name}` };
    },

    async read({ filename }) {
      const name = artistPortfolioFilename(filename);
      if (hasDatabase) {
        const { rows } = await db.query("SELECT content_type, body FROM artist_portfolio_files WHERE filename = $1", [name]);
        if (rows[0]?.body) {
          const stored = Buffer.isBuffer(rows[0].body) ? rows[0].body : Buffer.from(rows[0].body);
          if (stored.length) return { body: stored, contentType: rows[0].content_type, filename: name };
        }
      }
      try {
        const body = await readFile(filePath(name));
        return { body, contentType: CONTENT_TYPES[name.split(".").pop()], filename: name };
      } catch (error) {
        if (error?.code === "ENOENT") throw fail(404, "PORTFOLIO_FILE_NOT_FOUND", "Artist portfolio image was not found.");
        throw error;
      }
    },
  };
}
