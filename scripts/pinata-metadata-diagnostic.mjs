import process from "node:process";
import { loadMetadataConfig } from "../server/config.js";

// Safe, read-only-by-default diagnostic for the exact failure "Pinata 403
// NO_SCOPES_FOUND on metadata publish". It classifies the three scenarios the
// runbook cares about using the server-side PINATA_JWT, and never prints the
// JWT, bearer token, API secret, or any signed URL.
//
//   A  testAuthentication fails            -> credential invalid/expired/unusable
//   B  testAuthentication ok, upload 403   -> credential valid but lacks the scope
//   C  metadata upload succeeds            -> pinJSONToIPFS scope present
//
// By default only the credential check (step A) runs. Pass --probe (or set
// CERT_PROBE_METADATA=1) to additionally exercise the exact pinJSONToIPFS upload
// so B and C can be told apart; the probe pins a tiny throwaway object and then
// best-effort unpins it.

const AUTH_ENDPOINT = "https://api.pinata.cloud/data/testAuthentication";
const DEFAULT_METADATA_ENDPOINT = "https://api.pinata.cloud/pinning/pinJSONToIPFS";

function sanitize(text) {
  return String(text ?? "")
    .replace(/https?:\/\/[^\s"']+/gi, "[redacted-url]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/(jwt|token|authorization|signature|secret|download_link)\s*[:=]\s*["']?[^,"'\s}]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")
    .slice(0, 500) || "[empty-body]";
}

function providerCode(body) {
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* provider may return plain text */ }
  const source = parsed?.error ?? parsed?.errors ?? parsed;
  const code = source && typeof source === "object" ? (source.reason ?? source.code ?? source.error_code) : null;
  return code ? String(code).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || null : null;
}

function endpointLabel(url) {
  try { const parsed = new URL(url); return `${parsed.host}${parsed.pathname}`; } catch { return "[invalid-endpoint]"; }
}

async function main() {
  const jwt = String(process.env.PINATA_JWT || "").trim();
  const probe = process.argv.includes("--probe") || String(process.env.CERT_PROBE_METADATA || "") === "1";

  console.log("PINATA_METADATA_SCOPE_DIAGNOSTIC_START");

  if (!jwt) {
    console.log("UNVERIFIED PINATA_JWT — the server-side PINATA_JWT is not present in this runtime.");
    console.log("Run this diagnostic where the production credential is configured (e.g. the Render service shell).");
    process.exitCode = 2;
    return;
  }

  let metadataEndpoint = DEFAULT_METADATA_ENDPOINT;
  try {
    const config = loadMetadataConfig({ ...process.env, METADATA_STORAGE_DRIVER: process.env.METADATA_STORAGE_DRIVER || "pinata" });
    if (config.driver === "pinata" && config.endpoint) metadataEndpoint = config.endpoint;
  } catch (error) {
    console.log(`UNVERIFIED METADATA_CONFIG — using default endpoint; ${sanitize(error?.message)}`);
  }

  console.log(`auth_endpoint=${endpointLabel(AUTH_ENDPOINT)}`);
  console.log(`metadata_endpoint=${endpointLabel(metadataEndpoint)}`);

  // Step A — is the credential itself accepted?
  let authOk = false;
  try {
    const response = await fetch(AUTH_ENDPOINT, { headers: { authorization: `Bearer ${jwt}` } });
    authOk = response.status === 200;
    console.log(`PINATA_AUTH_TEST status=${response.status} classification=${authOk ? "credential-valid" : "credential-rejected"}`);
  } catch (error) {
    console.log(`PINATA_AUTH_TEST status=error classification=unreachable detail=${sanitize(error?.message)}`);
  }

  if (!probe) {
    console.log("METADATA_UPLOAD_PROBE skipped — pass --probe (or CERT_PROBE_METADATA=1) to test the exact pinJSONToIPFS scope.");
    console.log(authOk
      ? "SCENARIO=A cleared (credential valid). Re-run with --probe to distinguish B (scope missing) from C (working)."
      : "SCENARIO=A (credential invalid/expired or unreachable). Fix or rotate the Pinata credential.");
    process.exitCode = authOk ? 2 : 1;
    return;
  }

  // Step B/C — the exact metadata upload operation.
  let scenario = "unknown";
  let ok = false;
  try {
    const response = await fetch(metadataEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ pinataContent: { void_diagnostic: true, at: new Date().toISOString() }, pinataMetadata: { name: "void-metadata-scope-diagnostic" } }),
    });
    const body = await response.text().catch(() => "");
    const code = providerCode(body);
    if (response.ok) {
      ok = true;
      let cid = null;
      try { cid = JSON.parse(body)?.IpfsHash || null; } catch { /* ignore */ }
      scenario = "C (metadata upload succeeded — pinJSONToIPFS scope present)";
      console.log(`METADATA_UPLOAD_PROBE status=${response.status} classification=scope-present${cid ? ` cid=${cid}` : ""}`);
      if (cid) {
        try {
          const unpin = await fetch(`https://api.pinata.cloud/pinning/unpin/${encodeURIComponent(cid)}`, { method: "DELETE", headers: { authorization: `Bearer ${jwt}` } });
          console.log(`METADATA_UPLOAD_CLEANUP status=${unpin.status} ${unpin.ok ? "diagnostic pin removed" : "diagnostic pin left in place (unpin scope absent)"}`);
        } catch (error) { console.log(`METADATA_UPLOAD_CLEANUP status=error diagnostic pin left in place detail=${sanitize(error?.message)}`); }
      }
    } else if (response.status === 401 || response.status === 403) {
      scenario = code === "NO_SCOPES_FOUND"
        ? "B (credential valid but missing the pinJSONToIPFS scope)"
        : `B (authorization failure${code ? `: ${code}` : ""})`;
      console.log(`METADATA_UPLOAD_PROBE status=${response.status} classification=scope-missing code=${code || "unspecified"} body=${sanitize(body)}`);
    } else {
      scenario = `provider error (HTTP ${response.status})`;
      console.log(`METADATA_UPLOAD_PROBE status=${response.status} classification=provider-error body=${sanitize(body)}`);
    }
  } catch (error) {
    console.log(`METADATA_UPLOAD_PROBE status=error classification=unreachable detail=${sanitize(error?.message)}`);
  }

  console.log(`SCENARIO=${scenario}`);
  if (scenario.startsWith("B")) {
    console.log("REQUIRED_SCOPE=pinJSONToIPFS (legacy pinning). Enable it on the production Pinata key alongside the existing V3 Files scopes, then update the Render PINATA_JWT secret.");
  }
  process.exitCode = ok ? 0 : 1;
}

await main();
