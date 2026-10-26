#!/usr/bin/env node
// CI guard for the mainnet web build (npm run build:mainnet). Walks every JS chunk the site entry
// (index.html) loads, statically or lazily, and fails if it carries Fuji (43113) network
// configuration: a Fuji chain ID or hex chain ID assigned as config, or the Fuji RPC host.
// Comparisons such as `id===43113` (labels for a wallet on the wrong chain) are not configuration
// and are allowed. Raw Fuji contract addresses are not matched: wallets are shared across networks
// and some code names the Fuji singleton only to reject it. The owner signing page
// (owner-deploy.html) is a separate entry that lists both networks by design and is not scanned.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG_PATTERNS = [
  { name: "Fuji chainId", pattern: /chainId\s*:\s*[`"']?43113\b/ },
  { name: "Fuji chainHexId", pattern: /[`"']0xa869[`"']/i },
  { name: "Fuji RPC host", pattern: /api\.avax-test\.network/ },
];

/** Findings for one chunk's source. */
export function scanChunk(source) {
  return CONFIG_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(({ name }) => name);
}

/** JS chunks reachable from the entry HTML: script/modulepreload tags, then relative imports. */
export function reachableChunks(distDir, readFile = (file) => readFileSync(file, "utf8")) {
  const html = readFile(path.join(distDir, "index.html"));
  const queue = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((match) => match[1]);
  const seen = new Set();
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const source = readFile(path.join(distDir, rel));
    for (const match of source.matchAll(/["'`](\.\/[\w.-]+\.js)["'`]/g)) queue.push(path.posix.join(path.posix.dirname(rel), match[1]));
  }
  return [...seen];
}

function main() {
  const distDir = path.resolve(root, process.argv[2] || "deploy/vercel-mainnet/dist");
  if (!existsSync(path.join(distDir, "index.html"))) {
    console.error(`No build at ${distDir}. Run npm run build:mainnet first.`);
    process.exit(2);
  }
  const chunks = reachableChunks(distDir);
  let failed = false;
  for (const chunk of chunks) {
    const findings = scanChunk(readFileSync(path.join(distDir, chunk), "utf8"));
    if (findings.length) {
      failed = true;
      console.error(`${chunk}: ${findings.join(", ")}`);
    }
  }
  if (failed) process.exit(1);
  console.log(`Mainnet bundle clean: ${chunks.length} chunks reachable from index.html carry no Fuji network configuration.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
