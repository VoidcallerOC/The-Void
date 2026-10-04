import { ipfsToHttp } from "./web3.js";

// The marketplace hero is its own admin-set asset. It is never taken from a
// release, edition, token or listing image; with nothing configured the hero
// shows no artwork rather than an arbitrary catalog image.
const ASSET_PATH = /^\/assets\/[A-Za-z0-9._/-]+\.(png|jpe?g|gif|webp|avif)$/i;
const IPFS_URI = /^ipfs:\/\/[A-Za-z0-9]{20,}(\/[A-Za-z0-9._-]+)*$/;

export function validateMarketplaceArtwork(value) {
  if (value === null || value === undefined || String(value).trim() === "") return { ok: true, value: null };
  const raw = String(value).trim();
  if (raw.length > 2048) return { ok: false, error: "Artwork reference is too long." };
  if (/["'()\\\s<>]/.test(raw)) return { ok: false, error: "Artwork reference contains characters that are not allowed." };
  if (ASSET_PATH.test(raw) || IPFS_URI.test(raw)) return { ok: true, value: raw };
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return { ok: true, value: url.toString() };
  } catch { /* fall through */ }
  return { ok: false, error: "Use an https:// image URL, an ipfs:// URI, or a /assets/ image path." };
}

const LOCAL_HERO_FILE = /^\/assets\/marketplace-heroes\/(marketplace-hero-[a-f0-9]{16}\.(?:png|jpg|gif|webp))$/;

export function marketplaceHeroImage(presentation) {
  const checked = validateMarketplaceArtwork(presentation?.heroArtwork);
  if (!checked.ok || !checked.value) return null;
  const local = LOCAL_HERO_FILE.exec(checked.value);
  if (local) {
    // Uploaded header files live on the site (public/assets/marketplace-heroes)
    // and are served by the API, which is what the Vercel host proxies. They
    // are not Pinata gateway URLs.
    const configured = typeof import.meta !== "undefined" ? import.meta.env?.VITE_API_ORIGIN : "";
    const base = configured ? String(configured).replace(/\/$/, "") : "";
    return `${base}/api/marketplace/heroes/${local[1]}`;
  }
  return ipfsToHttp(checked.value);
}
