import process from "node:process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const CONTENT_TYPES = Object.freeze({ mp3: "audio/mpeg", mp4: "video/mp4", webm: "video/webm", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4" });

function safeKey(key) {
  const value = String(key || "").trim();
  if (!value || value.includes("\\") || value.startsWith("/") || value.split("/").some((part) => part === ".." || part === ".")) throw new Error("Invalid media key.");
  return value;
}

export function createPrivateMediaStore({ root = process.env.PRIVATE_MEDIA_ROOT || path.resolve(process.cwd(), "private-media") } = {}) {
  const rootPath = path.resolve(root);
  function resolve(key) {
    const clean = safeKey(key);
    const file = path.resolve(rootPath, clean);
    if (file !== rootPath && !file.startsWith(`${rootPath}${path.sep}`)) throw new Error("Invalid media key.");
    return { key: clean, file };
  }
  return {
    root: rootPath,
    async stat(key) {
      const resolved = resolve(key);
      const info = await stat(resolved.file);
      return { ...resolved, size: info.size, contentType: CONTENT_TYPES[path.extname(resolved.file).slice(1).toLowerCase()] || "application/octet-stream" };
    },
    stream(key, options) {
      return createReadStream(resolve(key).file, options);
    },
    resolve,
  };
}

export function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2] || 0));
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}
