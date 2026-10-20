// Browser acceptance for the artist Earnings flow against a LOCAL FORK of Avalanche C-Chain.
// No mainnet transaction is sent: the page's RPC reads and the withdraw transaction are routed to
// anvil, the artist wallet is impersonated on the fork, and /api/* is a stub of the production API.
//
//   anvil --fork-url https://api.avax.network/ext/bc/C/rpc --chain-id 43114 --auto-impersonate --port 8545 &
//   VITE_RELEASE_NETWORK=mainnet VITE_MARKETPLACE_CHAIN_ID=43114 VITE_MARKETPLACE_ADDRESS=0x0e77116142844478a55EEd2Ab79de9F93770F8f5 \
//     VITE_MARKETPLACE_FEE_BPS=250 npx vite build --outDir /tmp/mainnet-dist --emptyOutDir
//   npm i --no-save playwright-core && MAINNET_DIST=/tmp/mainnet-dist node test/mainnet-fork/earnings-browser-e2e.mjs
//
// Requires the live sale 0x6ae84a51...f9aa3 to still hold the 0.24375 AVAX artist credit.
// Not part of `npm test`.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { chromium } from "playwright-core";
const DIST = process.env.MAINNET_DIST || "dist", FORK = process.env.MAINNET_FORK_RPC || "http://127.0.0.1:8545", PORT = 5199;
const ARTIST = "0x284c09a7cc187e096cbbdc88d99defe6df32180a";
const SALE = "0x6ae84a51f100f10f0535a514555043ae9edf9aa3", RELEASE = "0x9aa6165b493ac50d0f8cdee2fd48a3c5155fd103", FACTORY = "0x262b774cf9a1949170b58e2d57f6189980fe757b";
const TOKEN = "25679935302133066722236771263728427871936411831072189551573738559199048803312";
const apiHits = [];
const catalog = {
  artists: [{ id: "voidcaller", display_name: "Voidcaller", slug: "voidcaller", status: "ACTIVE" }],
  releases: [{ id: "release-83611741-c9ee-4487-a438-b6fa844762e6", artist_id: "voidcaller", title: "Forgive & Forget", status: "PUBLISHED", type: "SINGLE" }],
  editions: [{ id: "edition-6e35101c-4987-4695-ac96-d83061ef2673", release_id: "release-83611741-c9ee-4487-a438-b6fa844762e6", title: "Forgive & Forget", status: "PUBLISHED", supply: 0, application_metadata: {}, contract_address: RELEASE, release_contract_address: RELEASE, factory_address: FACTORY, primary_sale_address: SALE, chain_id: 43114, token_id: TOKEN, buyable_sale: true }],
  experiences: [], albumSingles: [],
  releaseBindings: [{ release_id: "release-83611741-c9ee-4487-a438-b6fa844762e6", chain_id: 43114, artist_wallet: ARTIST, release_contract_address: RELEASE, factory_address: FACTORY, primary_sale_address: SALE, artist_earned_wei: "243750000000000000" }],
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    apiHits.push(`${req.method} ${url.pathname}`);
    const send = (o, c = 200) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify({ data: o })); };
    if (url.pathname === "/api/auth/nonce") return send({ nonce: "n1", message: "Sign in to The Void (e2e stub)" });
    if (url.pathname === "/api/auth/verify") return send({ token: "stub-token", wallet: ARTIST, chainId: 43114, expiresAt: Date.now() + 3.6e6 });
    if (url.pathname === "/api/studio/catalog") return send(catalog);
    return send({}, 200);
  }
  let file = path.join(DIST, url.pathname === "/" ? "index.html" : url.pathname);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" }); fs.createReadStream(file).pipe(res);
}).listen(PORT);

const rpc = async (method, params = []) => { const r = await (await fetch(FORK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json(); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.result; };
const snap = await rpc("evm_snapshot");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
const log = []; page.on("pageerror", (e) => log.push("pageerror: " + e.message)); page.on("console", (m) => { if (m.type() === "error") log.push("console: " + m.text().slice(0, 200)); });
// Mainnet RPC reads in the page go to the fork, never to the real chain.
await page.route("https://api.avax.network/**", async (route) => { const body = JSON.parse(route.request().postData() || "{}"); const out = await fetch(FORK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: await out.text() }); });
const sent = [];
await page.exposeFunction("__wallet", async (method, params) => {
  if (method === "eth_requestAccounts" || method === "eth_accounts") return [ARTIST];
  if (method === "eth_chainId") return "0xa86a";
  if (method === "net_version") return "43114";
  if (method === "personal_sign") return "0x" + "11".repeat(65);
  if (method === "wallet_switchEthereumChain") return null;
  if (method === "eth_sendTransaction") sent.push(params[0]);
  return rpc(method, params);
});
await page.addInitScript(({ artist }) => {
  const provider = { isMetaMask: true, request: ({ method, params }) => window.__wallet(method, params), on() {}, removeListener() {} };
  window.ethereum = provider;
  window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "e2e", name: "E2E Wallet", icon: "data:image/svg+xml;base64,PHN2Zy8+", rdns: "xyz.e2e" }, provider }) })));
}, { artist: ARTIST });
const shot = async (n) => page.screenshot({ path: `${process.env.SHOT_DIR || "."}/shot-${n}.png`, fullPage: true });
const step = async (name, fn) => { try { await fn(); console.log("OK  ", name); } catch (e) { console.log("FAIL", name, "-", String(e.message).split("\n")[0]); await shot("fail-" + name.replace(/\W+/g, "-")); throw e; } };
let exitCode = 0;
try {
  await page.goto(`http://localhost:${PORT}/studio`, { waitUntil: "networkidle" });
  await step("studio page loads", async () => { await page.getByText(/studio/i).first().waitFor({ timeout: 10000 }); });
  await step("connect and sign in with the artist wallet", async () => {
    for (let i = 0; i < 3; i++) {
      if (!(await page.getByText("Verified wallet required.").count())) break;
      await page.getByText(/auth required|connect/i).first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
    await page.waitForFunction(() => !document.body.innerText.includes("Verified wallet required."), null, { timeout: 15000 });
  });
  await step("earnings card is discoverable", async () => { await page.getByRole("button", { name: /^03\s*Earnings|Earnings/ }).first().click(); await page.locator('section[aria-label="Earnings"]').waitFor(); });
  await step("balance shown from live fork", async () => { await page.getByTestId("earnings-withdrawable").waitFor({ timeout: 15000 }); const t = await page.getByTestId("earnings-withdrawable").innerText(); if (t !== "0.24375 AVAX") throw new Error("withdrawable=" + t); });
  await shot("before");
  const before = BigInt(await rpc("eth_getBalance", [ARTIST, "latest"]));
  await step("withdraw through the UI", async () => { await page.getByRole("button", { name: /Withdraw from Forgive/ }).click(); await page.getByTestId(`confirmed-${SALE}`).waitFor({ timeout: 20000 }); console.log("     ", await page.getByTestId(`confirmed-${SALE}`).innerText()); });
  await shot("after");
  const after = BigInt(await rpc("eth_getBalance", [ARTIST, "latest"]));
  console.log("fork artist balance delta (wei):", (after - before).toString(), "| txs requested from wallet:", sent.length, "| to:", sent.map((t) => t.to).join(","), "| data:", sent.map((t) => t.data).join(","));
  console.log("sale balance after (wei):", BigInt(await rpc("eth_getBalance", [SALE, "latest"])).toString());
} catch (e) { exitCode = 1; console.log("page log:", log.slice(0, 8)); console.log("auth text:", (await page.locator("[role=alert]").allInnerTexts()).slice(0,3)); console.log("api hits:", [...new Set(apiHits)]); }
await rpc("evm_revert", [snap]); await browser.close(); server.close(); process.exit(exitCode);
