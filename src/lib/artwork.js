import { LEGACY_IPFS_MEDIA } from "./legacy-genesis.js";

// Public Pinata gateway: throttled for anonymous traffic (measured 3.7–6.6 s to first byte on a cache hit,
// 2026-10-25). It stays the last resort, and the only route for content this account did not pin.
export const PUBLIC_IPFS_GATEWAY = "https://gateway.pinata.cloud/ipfs/";
export const DEFAULT_ARTWORK_WIDTH = 800;

const env = typeof import.meta !== "undefined" ? (import.meta.env || {}) : {};

/**
 * The account's dedicated Pinata gateway (VITE_IPFS_GATEWAY, baked into the mainnet build), normalized to
 * `https://host/ipfs/`. Empty when unset or not https, so every caller falls back to the public gateway.
 */
export function dedicatedIpfsGateway(value = env.VITE_IPFS_GATEWAY) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") return "";
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path.endsWith("/ipfs") ? path : `${path}/ipfs`}/`;
  } catch {
    return "";
  }
}

// Genesis media was pinned elsewhere; the dedicated gateway refuses it (HTTP 403), so it goes straight to the public one.
const LEGACY_PATHS = new Set(Object.values(LEGACY_IPFS_MEDIA).flatMap((media) => [media.image, media.animationUrl]).filter(Boolean).map((uri) => uri.slice("ipfs://".length)));

/** `cid[/path]` for an ipfs:// URI or a gateway URL of one; null for anything else (site files, http images). */
export function ipfsPath(uri, gateway = dedicatedIpfsGateway()) {
  const text = String(uri || "").trim();
  if (!text) return null;
  if (text.startsWith("ipfs://")) return text.slice("ipfs://".length).replace(/^\/+/, "") || null;
  for (const prefix of [PUBLIC_IPFS_GATEWAY, gateway].filter(Boolean)) {
    if (text.startsWith(prefix)) return text.slice(prefix.length).split(/[?#]/)[0] || null;
  }
  return null;
}

/**
 * Candidate URLs for one artwork, best first; an <img> walks them on error (TokenArtwork). An ipfs image pinned by
 * this account is served by the dedicated gateway, resized to `width` and (unless it is a GIF, whose animation a
 * format change would drop) converted to WebP by the gateway's image optimization; then the same gateway unresized;
 * then the public gateway. Non-ipfs sources are returned as given. Measured on the launch edition's cover
 * (2.58 MB PNG): public gateway 3.7–6.6 s to first byte; dedicated, 640 px WebP: 118 KB, under 1 s.
 */
export function artworkSources(uri, { width = DEFAULT_ARTWORK_WIDTH, gateway = dedicatedIpfsGateway() } = {}) {
  const text = String(uri || "").trim();
  if (!text) return [];
  const path = ipfsPath(text, gateway);
  if (!path) return [text];
  const publicUrl = `${PUBLIC_IPFS_GATEWAY}${path}`;
  if (!gateway || LEGACY_PATHS.has(path)) return [publicUrl];
  const size = Number.isInteger(width) && width > 0 ? width : null;
  const gif = /\.gif$/i.test(path);
  const optimized = size ? `${gateway}${path}?img-width=${size}${gif ? "" : "&img-format=webp"}` : null;
  return [...new Set([optimized, `${gateway}${path}`, publicUrl].filter(Boolean))];
}

/** The best single URL for an artwork (first of artworkSources). */
export function artworkSrc(uri, options) {
  return artworkSources(uri, options)[0] || "";
}
