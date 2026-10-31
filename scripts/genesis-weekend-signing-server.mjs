#!/usr/bin/env node
// Local-only server for the Genesis weekend owner-signing page. Binds 127.0.0.1, serves a fixed allowlist of
// files (no directory listing, no other paths), sends a strict CSP, and prints each file's SHA-256 so the owner
// can compare it with the reviewed commit. It never touches a key, a wallet, or the chain.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIGNING = join(ROOT, "deploy/mainnet/genesis-weekend/signing");

export const FILES = Object.freeze({
  "/": { path: join(SIGNING, "index.html"), type: "text/html; charset=utf-8" },
  "/index.html": { path: join(SIGNING, "index.html"), type: "text/html; charset=utf-8" },
  "/signing.js": { path: join(SIGNING, "signing.js"), type: "text/javascript; charset=utf-8" },
  "/core.js": { path: join(SIGNING, "core.js"), type: "text/javascript; charset=utf-8" },
  "/manifest.json": { path: join(SIGNING, "manifest.json"), type: "application/json" },
  "/artifact.json": { path: join(ROOT, "deploy/mainnet/genesis-weekend/GenesisWeekendClaim.artifact.json"), type: "application/json" },
  "/vendor/ethers.min.js": { path: join(ROOT, "node_modules/ethers/dist/ethers.min.js"), type: "text/javascript; charset=utf-8" },
});

export const HOST = "127.0.0.1";
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function loadFiles() {
  const loaded = {};
  for (const [route, { path, type }] of Object.entries(FILES)) {
    const body = readFileSync(path);
    loaded[route] = { body, type, path, sha256: createHash("sha256").update(body).digest("hex") };
  }
  return loaded;
}

export function createSigningServer(files = loadFiles()) {
  return createServer((request, response) => {
    const headers = { "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", "Cross-Origin-Opener-Policy": "same-origin" };
    const host = String(request.headers.host || "");
    // Reject anything not addressed to the loopback name (blocks DNS-rebinding pages from reading the files).
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) || request.method !== "GET") {
      response.writeHead(403, headers).end("forbidden");
      return;
    }
    const file = files[new URL(request.url, "http://127.0.0.1").pathname];
    if (!file) { response.writeHead(404, headers).end("not found"); return; }
    response.writeHead(200, { ...headers, "Content-Type": file.type }).end(file.body);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8790);
  const files = loadFiles();
  for (const [route, file] of Object.entries(files)) if (route !== "/") console.log(`sha256 ${file.sha256}  ${route}`);
  createSigningServer(files).listen(port, HOST, () => {
    console.log(`\nGenesis weekend signing page: http://${HOST}:${port}/  (local only; Ctrl+C to stop)`);
  });
}
