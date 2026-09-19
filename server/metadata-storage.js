import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { ApiError } from "./api-errors.js";

const MAX_METADATA_BYTES = 64 * 1024;

function text(value, max = 20000) {
  const result = String(value ?? "").trim();
  return result ? result.slice(0, max) : null;
}

function providerFailure(response, body) {
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* provider may return plain text */ }
  const source = parsed?.error ?? parsed?.errors ?? parsed;
  const reason = typeof source === "string" ? source : source?.reason || source?.message || source?.details || "provider rejected the request";
  const rawCode = source && typeof source === "object" ? (source.reason ?? source.code ?? source.error_code) : null;
  const safeReason = String(reason).replace(/https?:\/\/[^\s)]+/gi, "[redacted-url]").replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]").replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 240);
  const code = rawCode ? String(rawCode).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || null : null;
  // An authenticated-but-unscoped key (Pinata "NO_SCOPES_FOUND"), an invalid/expired
  // credential (401), or any forbidden response (403) all mean the operator must fix
  // the configured key rather than the release. The raw JWT never reaches this object.
  const authorization = response.status === 401 || response.status === 403;
  return { provider: "pinata", status: response.status, code, reason: safeReason, authorization };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

export function canonicalMetadata(input) {
  if (!input?.release || !input?.edition) throw new ApiError(400, "METADATA_INPUT_INVALID", "Release details are required before metadata can be published.");
  const release = input.release;
  const edition = input.edition;
  const metadata = {
    name: text(edition.title, 256) || text(release.title, 256),
    description: text(edition.description || release.description, 20000),
    image: text(input.artwork || release.artwork || edition.artwork, 2048),
    artist: text(input.artist?.name || input.artist?.display_name, 256),
    release: {
      title: text(release.title, 256),
      type: text(input.releaseType, 64),
      description: text(release.description, 20000),
    },
    collectorBenefits: Array.isArray(input.includes) ? input.includes.map((item) => text(item, 512)).filter(Boolean) : [],
    experiences: Array.isArray(input.experiences) ? input.experiences.map((experience) => ({ name: text(experience.title, 256), description: text(experience.description, 20000), type: text(experience.experience_type || experience.type, 64) })).filter((item) => item.name || item.description || item.type) : [],
    attributes: [
      { trait_type: "Supply", value: String(edition.supply ?? "") },
      ...(text(input.tier, 128) ? [{ trait_type: "Tier", value: text(input.tier, 128) }] : []),
    ],
  };
  const normalized = stableValue(metadata);
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) throw new ApiError(400, "METADATA_TOO_LARGE", "Release metadata is too large to publish.");
  if (!normalized.name || !normalized.artist) throw new ApiError(400, "METADATA_INPUT_INVALID", "A release title and artist are required before metadata can be published.");
  return { metadata: normalized, serialized, digest: createHash("sha256").update(serialized).digest("hex") };
}

export class PinataMetadataStorage {
  constructor({ config, fetchImpl = fetch, logger = console } = {}) {
    if (!config?.endpoint || !config?.jwt) throw new TypeError("Pinata metadata storage requires endpoint and JWT configuration.");
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
  }

  async write({ metadata, name }) {
    const response = await this.fetchImpl(this.config.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.config.jwt}` },
      body: JSON.stringify({ pinataContent: metadata, pinataMetadata: { name } }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const details = providerFailure(response, body);
      this.logger.error?.("metadata.storage.failed", details);
      const guidance = details.authorization ? "Metadata storage authorization failed. Check the configured Pinata API key permissions. " : "";
      throw new ApiError(503, "METADATA_STORAGE_UNAVAILABLE", `${guidance}Metadata provider rejected the upload (HTTP ${response.status}): ${details.reason}. Nothing was written on-chain.`, details);
    }
    const body = await response.json().catch(() => null);
    const cid = String(body?.IpfsHash || "").trim();
    if (!/^(?:bafy|Qm)/.test(cid)) throw new ApiError(503, "METADATA_URI_INVALID", "Metadata storage returned an invalid immutable identifier.");
    return { uri: `ipfs://${cid}`, cid };
  }
}

export function createPinataMetadataStorage(options) { return new PinataMetadataStorage(options); }
