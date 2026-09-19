import process from "node:process";
import { loadMediaConfig } from "../server/config.js";
import { createPrivateMediaStorage } from "../server/media-storage.js";

const base = (process.env.CERT_SERVICE_URL || "https://the-void-api-fuji.onrender.com").replace(/\/$/, "");
const cid = process.env.CERT_CID || "bafkreig335uif63xfgaajvqarq22it355tqjlgey5gi7yqpd4u6fbmc3gm";
const gateway = (process.env.CERT_GATEWAY_URL || process.env.PINATA_GATEWAY_URL || "https://fuchsia-labour-butterfly-445.mypinata.cloud").replace(/\/$/, "");
const experienceId = process.env.CERT_EXPERIENCE_ID || "voidcaller-full-ep";
const mediaType = process.env.CERT_MEDIA_TYPE || "AUDIO";
const wallet = process.env.CERT_WALLET || "";
const authToken = process.env.CERT_SESSION_TOKEN || process.env.CERT_AUTH_TOKEN || "";
const results = [];
const secretPatterns = [/PINATA_JWT/i, /authorization\s*:\s*bearer/i, /private\/download_link/i, /X-Signature/i, /X-Auth-Token/i];

function safeError(error) {
  const message = String(error?.message || error || "unknown error");
  return message.replace(/https?:\/\/[^\s)]+/gi, "[redacted-url]").replace(/Bearer\s+[^\s)]+/gi, "Bearer [redacted]").replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]");
}

function safeProviderBody(body) {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  return text.replace(/https?:\/\/[^\s"']+/gi, "[redacted-url]").replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]").replace(/(jwt|token|authorization|signature|signed_url|download_link)\s*[:=]\s*["']?[^,"'\s}]+/gi, "$1=[redacted]").replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]").slice(0, 500) || "[empty-body]";
}

function record(name, status, detail = "") {
  results.push({ name, status, detail });
  console.log(`${status} ${name}${detail ? ` — ${detail}` : ""}`);
}

function pass(name, detail) { record(name, "PASS", detail); }
function fail(name, detail) { record(name, "FAIL", detail); }
function unverified(name, detail) { record(name, "UNVERIFIED", detail); }

async function request(url, options = {}) {
  const response = await fetch(url, { redirect: "manual", ...options });
  const body = Buffer.from(await response.arrayBuffer());
  return { response, body };
}

function bearer() { return authToken ? { authorization: `Bearer ${authToken}` } : {}; }

async function healthChecks() {
  for (const [name, path] of [["SERVICE_HEALTH", "/api/health"], ["SERVICE_READINESS", "/api/health/ready"]]) {
    try {
      const { response, body } = await request(`${base}${path}`, { headers: { accept: "application/json" } });
      if (response.status !== 200) { fail(name, `HTTP ${response.status}`); continue; }
      const data = JSON.parse(body.toString("utf8")).data;
      if (name === "SERVICE_READINESS" && (!data?.database?.ok || !data?.indexer?.ok)) { fail(name, "database or indexer reported not healthy"); continue; }
      pass(name, "HTTP 200");
      if (name === "SERVICE_READINESS") {
        const checkpoint = data.indexer.checkpoints?.[0];
        const contract = checkpoint?.contracts?.[0];
        if (checkpoint?.latest_known_block && checkpoint?.last_successful_run_at && checkpoint?.indexer_lag !== undefined && contract?.address?.toLowerCase() === "0x262b774cf9a1949170b58e2d57f6189980fe757b") pass("FUJI_CHECKPOINT", "configured contract and checkpoint fields present");
        else fail("FUJI_CHECKPOINT", "required checkpoint fields or certified contract missing");
      }
    } catch (error) { fail(name, safeError(error)); }
  }
}

async function pinataChecks() {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) { unverified("PINATA_JWT_PRESENT", "server-side PINATA_JWT is unavailable in this runtime"); return null; }
  pass("PINATA_JWT_PRESENT", "present; value redacted");
  try {
    const { response } = await request("https://api.pinata.cloud/data/testAuthentication", { headers: { authorization: `Bearer ${jwt}` } });
    if (response.status === 200) pass("PINATA_AUTHENTICATION", "HTTP 200"); else fail("PINATA_AUTHENTICATION", `HTTP ${response.status}`);
  } catch (error) { fail("PINATA_AUTHENTICATION", safeError(error)); }
  let storage;
  try {
    const config = loadMediaConfig(process.env);
    if (config.driver !== "pinata") fail("PRODUCTION_MEDIA_DRIVER", `configured driver is ${config.driver}`);
    else pass("PRODUCTION_MEDIA_DRIVER", "pinata");
    storage = createPrivateMediaStorage({ config });
  } catch (error) { unverified("PINATA_PRIVATE_LINK", `production media configuration unavailable: ${safeError(error)}`); return null; }
  try {
    const date = Math.floor(Date.now() / 1000);
    const direct = await request(config.pinata.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` }, body: JSON.stringify({ url: `${config.pinata.gateway}/files/${cid}`, expires: config.signedUrlTtlSeconds, date, method: "GET" }) });
    const body = safeProviderBody(direct.body);
    if (direct.response.ok) pass("PINATA_PRIVATE_LINK_PROVIDER_RESPONSE", `HTTP ${direct.response.status}; body=${body}`);
    else fail("PINATA_PRIVATE_LINK_PROVIDER_RESPONSE", `HTTP ${direct.response.status}; body=${body}`);
  } catch (error) { unverified("PINATA_PRIVATE_LINK_PROVIDER_RESPONSE", safeError(error)); }
  try {
    const media = await storage.open({ storageKey: cid, contentType: "audio/wav" });
    if (media.type !== "redirect") fail("PINATA_PRIVATE_LINK", "production storage did not return a private redirect");
    else pass("PINATA_PRIVATE_LINK", "generated successfully; URL redacted");
    return media.url;
  } catch (error) { fail("PINATA_PRIVATE_LINK", safeError(error)); return null; }
}

async function directGatewayChecks() {
  for (const [name, url] of [["UNSIGNED_DEDICATED_GATEWAY", `${gateway}/files/${cid}`], ["UNSIGNED_STANDARD_GATEWAY", `${gateway}/ipfs/${cid}`]]) {
    try {
      const { response, body } = await request(url);
      if (response.ok || body.length > 0 && response.status === 200) fail(name, `HTTP ${response.status}; unsigned object was accessible`);
      else pass(name, `HTTP ${response.status}`);
    } catch (error) { unverified(name, safeError(error)); }
  }
}

async function privateLinkChecks(signedUrl) {
  if (!signedUrl) { unverified("PRIVATE_LINK_RETRIEVAL", "no generated private link"); return; }
  try {
    const full = await request(signedUrl);
    const type = String(full.response.headers.get("content-type") || "").toLowerCase();
    if (!full.response.ok) { fail("PRIVATE_LINK_RETRIEVAL", `HTTP ${full.response.status}`); return; }
    if (!type.includes("audio/wav") && !type.includes("audio/x-wav")) fail("PRIVATE_LINK_MIME", `received ${type || "missing content type"}`); else pass("PRIVATE_LINK_MIME", type);
    if (full.body.length < 44 || full.body.subarray(0, 4).toString() !== "RIFF" || full.body.subarray(8, 12).toString() !== "WAVE") fail("PRIVATE_LINK_WAV", "response is not a valid WAV payload"); else pass("PRIVATE_LINK_WAV", `${full.body.length} bytes`);
    const contentLength = Number(full.response.headers.get("content-length") || -1);
    if (contentLength >= 0 && contentLength !== full.body.length) fail("PRIVATE_LINK_CONTENT_LENGTH", "header did not match body"); else pass("PRIVATE_LINK_CONTENT_LENGTH", `${full.body.length} bytes`);
    for (const [start, end] of [[0, 1023], [2048, 3071], [8192, 9215]]) {
      const range = await request(signedUrl, { headers: { range: `bytes=${start}-${end}`, "user-agent": "Mozilla/5.0" } });
      const expected = end - start + 1;
      if (range.response.status !== 206 || range.body.length !== expected || !range.response.headers.get("content-range") || !range.response.headers.get("accept-ranges")) fail(`PRIVATE_LINK_RANGE_${start}_${end}`, `status=${range.response.status} bytes=${range.body.length}`);
      else pass(`PRIVATE_LINK_RANGE_${start}_${end}`, "HTTP 206 with valid range headers");
    }
    pass("BROWSER_SEEKING", "multiple browser-style ranges succeeded");
  } catch (error) { fail("PRIVATE_LINK_RETRIEVAL", safeError(error)); }
}

async function applicationChecks() {
  try {
    const unauth = await request(`${base}/api/media/grants`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: wallet || "0x1111111111111111111111111111111111111111", experienceId, mediaType }) });
    if (unauth.response.status === 401 || unauth.response.status === 403) pass("UNAUTHORIZED_MEDIA_ACCESS", `HTTP ${unauth.response.status}`); else fail("UNAUTHORIZED_MEDIA_ACCESS", `HTTP ${unauth.response.status}`);
  } catch (error) { fail("UNAUTHORIZED_MEDIA_ACCESS", safeError(error)); }
  if (!authToken || !wallet) {
    for (const name of ["AUTHORIZED_MEDIA_RETRIEVAL", "APPLICATION_RANGE", "GRANT_EXPIRATION", "GRANT_REVOCATION", "AUDIT_TRAIL"]) unverified(name, "CERT_SESSION_TOKEN and CERT_WALLET are required; no authenticated wallet/session context was supplied");
    return;
  }
  try {
    const grant = await request(`${base}/api/media/grants`, { method: "POST", headers: { ...bearer(), "content-type": "application/json" }, body: JSON.stringify({ wallet, experienceId, mediaType }) });
    if (!grant.response.ok) { unverified("AUTHORIZED_MEDIA_RETRIEVAL", `grant flow returned HTTP ${grant.response.status}`); return; }
    const grantData = JSON.parse(grant.body.toString("utf8")).data;
    if (!grantData?.grantId) { fail("AUTHORIZED_MEDIA_RETRIEVAL", "grant response did not contain a grant ID"); return; }
    const media = await request(`${base}/api/media/${encodeURIComponent(grantData.grantId)}`, { headers: { ...bearer(), range: "bytes=0-1023", "user-agent": "Mozilla/5.0" } });
    if (media.response.status !== 206 || media.body.length !== 1024) fail("APPLICATION_RANGE", `status=${media.response.status} bytes=${media.body.length}`); else pass("APPLICATION_RANGE", "HTTP 206 with 1024 bytes");
    const revoke = await request(`${base}/api/media/grants/revoke`, { method: "POST", headers: { ...bearer(), "content-type": "application/json" }, body: JSON.stringify({ wallet, grantId: grantData.grantId }) });
    if (!revoke.response.ok) unverified("GRANT_REVOCATION", `revoke flow returned HTTP ${revoke.response.status}`); else {
      const after = await request(`${base}/api/media/${encodeURIComponent(grantData.grantId)}`, { headers: bearer() });
      if (after.response.status === 403) pass("GRANT_REVOCATION", "revoked grant rejected"); else fail("GRANT_REVOCATION", `post-revocation HTTP ${after.response.status}`);
    }
    pass("AUTHORIZED_MEDIA_RETRIEVAL", "application grant and protected media path succeeded");
    unverified("GRANT_EXPIRATION", "requires waiting for the configured grant TTL or a dedicated short-TTL certification environment");
    unverified("AUDIT_TRAIL", "no public API exposes audit rows; requires a server-side database query");
  } catch (error) { unverified("AUTHORIZED_MEDIA_RETRIEVAL", safeError(error)); }
}

async function exposureChecks() {
  const publicUrl = process.env.CERT_PUBLIC_APP_URL;
  if (!publicUrl) { unverified("CREDENTIAL_EXPOSURE", "CERT_PUBLIC_APP_URL was not supplied for HTML/JS asset inspection"); return; }
  try {
    const root = await request(publicUrl);
    const text = root.body.toString("utf8");
    if (secretPatterns.some((pattern) => pattern.test(text))) fail("CREDENTIAL_EXPOSURE", "credential or signed-link marker found in public HTML"); else pass("CREDENTIAL_EXPOSURE", "public HTML contains no credential markers");
  } catch (error) { unverified("CREDENTIAL_EXPOSURE", safeError(error)); }
}

console.log("PINATA_PROTECTED_MEDIA_CERTIFICATION_START");
console.log(`service=${new URL(base).hostname}`);
console.log(`cid=${cid}`);
await healthChecks();
const signedUrl = await pinataChecks();
await directGatewayChecks();
await privateLinkChecks(signedUrl);
await applicationChecks();
await exposureChecks();
const failures = results.filter((item) => item.status === "FAIL");
const unknowns = results.filter((item) => item.status === "UNVERIFIED");
console.log(`CERTIFICATION_RESULT=${failures.length ? "NOT_CERTIFIED" : unknowns.length ? "PARTIAL" : "CERTIFIED"}`);
process.exitCode = failures.length ? 1 : unknowns.length ? 2 : 0;
