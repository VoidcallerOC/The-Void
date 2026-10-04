import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

// Content-addressed names only. The hash is the file; replacing the header
// writes a new file and points the presentation at it. Old files are left in
// place (nothing is deleted from Pinata or from this directory).
const FILENAME = /^marketplace-hero-[a-f0-9]{16}\.(png|jpg|gif|webp)$/;
const CONTENT_TYPES = Object.freeze({ png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" });

function fail(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function marketplaceHeroFilename(filename) {
  const name = String(filename || "");
  if (!FILENAME.test(name)) throw fail(400, "HERO_FILE_INVALID", "Marketplace hero filename is invalid.");
  return name;
}

export function createLocalMarketplaceHeroStore({ root, db = null } = {}) {
  if (!root) throw new TypeError("Marketplace hero storage requires a directory.");
  const directory = resolve(root);

  function filePath(name) {
    const path = resolve(directory, name);
    if (path !== directory && !path.startsWith(`${directory}${sep}`)) throw fail(400, "HERO_FILE_INVALID", "Marketplace hero path is invalid.");
    return path;
  }

  return {
    // Writes a file under public/assets/marketplace-heroes and, when a database
    // is configured, keeps the same bytes there so a redeploy can still serve them.
    async save({ body, filename, contentType }) {
      const name = marketplaceHeroFilename(filename);
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
      if (!bytes.length) throw fail(400, "ARTWORK_UPLOAD_EMPTY", "Artwork upload was empty.");
      if (!CONTENT_TYPES[name.split(".").pop()] || CONTENT_TYPES[name.split(".").pop()] !== contentType) {
        throw fail(400, "ARTWORK_TYPE_UNSUPPORTED", "Artwork must be a PNG, JPEG, GIF or WebP image.");
      }
      if (db?.query) {
        await db.query(
          `INSERT INTO marketplace_hero_files (filename, content_type, byte_size, body)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (filename) DO UPDATE SET content_type = EXCLUDED.content_type, byte_size = EXCLUDED.byte_size, body = EXCLUDED.body`,
          [name, contentType, bytes.length, bytes],
        );
      }
      await mkdir(directory, { recursive: true });
      await writeFile(filePath(name), bytes);
      return { uri: `/assets/marketplace-heroes/${name}` };
    },

    async read({ filename }) {
      const name = marketplaceHeroFilename(filename);
      if (db?.query) {
        const { rows } = await db.query("SELECT content_type, body FROM marketplace_hero_files WHERE filename = $1", [name]);
        if (rows[0]?.body) {
          const stored = Buffer.isBuffer(rows[0].body) ? rows[0].body : Buffer.from(rows[0].body);
          if (stored.length) return { body: stored, contentType: rows[0].content_type, filename: name };
        }
      }
      try {
        const body = await readFile(filePath(name));
        return { body, contentType: CONTENT_TYPES[name.split(".").pop()], filename: name };
      } catch (error) {
        if (error?.code === "ENOENT") throw fail(404, "HERO_FILE_NOT_FOUND", "Marketplace hero file was not found.");
        throw error;
      }
    },
  };
}
