// Artist profile: the one place an artist's own details live. Studio no
// longer asks for them per release; the artist page edits them for its owner.

import { ipfsToHttp } from "./web3.js";

const LOCAL_PORTFOLIO_FILE = /^\/assets\/artist-portfolio\/(artist-portfolio-[a-f0-9]{16}\.(?:png|jpg|gif|webp))$/;

/** Browser URL for a stored profile picture or banner.
 *  New uploads are site files served by the API. Older ipfs:// values still resolve. */
export function portfolioImageSrc(uri) {
  const raw = String(uri ?? "").trim();
  if (!raw) return "";
  const local = LOCAL_PORTFOLIO_FILE.exec(raw);
  if (!local) return ipfsToHttp(raw);
  const configured = typeof import.meta !== "undefined" ? import.meta.env?.VITE_API_ORIGIN : "";
  const base = configured ? String(configured).replace(/\/$/, "") : "";
  return `${base}/api/artists/portfolio/${local[1]}`;
}

export const PROFILE_LINKS = Object.freeze([
  ["website", "Website"],
  ["x", "X"],
  ["instagram", "Instagram"],
  ["discord", "Discord"],
]);

// Only http(s) URLs are ever stored or rendered, so a profile link can never
// become a javascript: or data: URL on the public page.
export function safeHttpUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

/** Public-page socials from a stored profile ({ key: url } plus website_url). */
export function profileSocials(socialLinks, websiteUrl = "") {
  const links = socialLinks && typeof socialLinks === "object" && !Array.isArray(socialLinks) ? socialLinks : {};
  const labels = Object.fromEntries(PROFILE_LINKS);
  const socials = [];
  const website = safeHttpUrl(websiteUrl || links.website);
  if (website) socials.push({ name: "Website", href: website });
  for (const [key, value] of Object.entries(links)) {
    if (key === "website") continue;
    const href = safeHttpUrl(value);
    if (href) socials.push({ name: labels[key] || key, href });
  }
  return socials;
}

/** Editable form state from an owned-artist row of GET /studio/catalog. */
export function profileFormFromRow(row = {}) {
  const meta = row.profile_metadata && typeof row.profile_metadata === "object" ? row.profile_metadata : {};
  const links = row.social_links && typeof row.social_links === "object" ? row.social_links : {};
  return {
    name: row.display_name || "",
    bio: row.bio || "",
    avatar: meta.profileArtwork || "",
    banner: meta.banner || "",
    links: Object.fromEntries(PROFILE_LINKS.map(([key]) => [key, key === "website" ? (row.website_url || links.website || "") : (links[key] || "")])),
  };
}

/** PATCH /studio/artists/:id payload. Keeps unrelated profile metadata. */
export function profilePayload(form, existingMetadata = {}) {
  const name = String(form.name || "").trim();
  if (!name) throw new Error("Artist name is required.");
  const links = {};
  for (const [key, label] of PROFILE_LINKS) {
    const raw = String(form.links?.[key] || "").trim();
    if (!raw) continue;
    const safe = safeHttpUrl(raw);
    if (!safe) throw new Error(`${label} must be a full http(s) link.`);
    if (key !== "website") links[key] = safe;
  }
  const website = form.links?.website ? safeHttpUrl(form.links.website) : "";
  const metadata = { ...(existingMetadata && typeof existingMetadata === "object" ? existingMetadata : {}) };
  if (form.banner) metadata.banner = form.banner; else delete metadata.banner;
  return {
    name,
    bio: String(form.bio || "").trim(),
    websiteUrl: website || null,
    links,
    profileArtwork: form.avatar || null,
    profileMetadata: metadata,
  };
}
