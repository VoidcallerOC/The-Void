// Read-only checklist for activating VoidPrimarySaleSettled on the EXISTING release. It sends no
// transaction and needs no key. It answers: is this sale the reviewed one, bound to this release
// and the platform wallet, the only account that can mint, with the historical credits intact?
//
//   node scripts/verify-settled-sale-activation.mjs --rpc https://api.avax.network/ext/bc/C/rpc --sale 0x...
//   npm run verify:settled-sale -- --rpc <url> --sale <address> [--release --factory --old-sale --artist
//        --platform-recipient --marketplace --from-block 97932485 --chunk 100 --concurrency 8]
//
// Exit code 0 only when every check passes.
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { ISSUER_ROLE, SETTLED_SALE_RUNTIME_CODE_HASH, verifyAuthorizedSale } from "../src/lib/sale-authorization.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RELEASE_ROLE_GRANTED = ethers.id("RoleGranted(bytes32,address,address)");
export const RELEASE_ROLE_REVOKED = ethers.id("RoleRevoked(bytes32,address,address)");

// The established mainnet deployment (validated against the repository manifest and the chain).
export const MAINNET_DEFAULTS = Object.freeze({
  chainId: 43114,
  release: "0x9Aa6165B493ac50d0f8CDee2FD48a3C5155FD103",
  oldSale: "0x6ae84a51f100f10f0535a514555043ae9edf9aa3",
  fromBlock: 97932485,
  chunk: 100,
  concurrency: 8,
});

const ifaces = {
  sale: new ethers.Interface(["function balances(address) view returns (uint256)"]),
  release: new ethers.Interface(["function hasRole(bytes32,address) view returns (bool)", "function releaseKey() view returns (bytes32)"]),
  factory: new ethers.Interface(["function isRelease(address) view returns (bool)", "function primarySaleOf(address) view returns (address)"]),
  marketplace: new ethers.Interface(["function registry() view returns (address)"]),
};
const lower = (value) => String(value || "").toLowerCase();
const addr = (value) => (ethers.isAddress(value || "") ? ethers.getAddress(value) : "");

export function parseArgs(argv, manifest = {}) {
  const out = { ...MAINNET_DEFAULTS, factory: manifest.factoryAddress, marketplace: manifest.marketplaceAddress, platformRecipient: manifest.platformRecipient, artist: manifest.artistWallet };
  const map = { "--rpc": "rpc", "--sale": "sale", "--release": "release", "--factory": "factory", "--old-sale": "oldSale", "--artist": "artist", "--platform-recipient": "platformRecipient", "--marketplace": "marketplace", "--from-block": "fromBlock", "--chunk": "chunk", "--concurrency": "concurrency", "--chain-id": "chainId" };
  for (let i = 0; i < argv.length; i += 2) {
    const key = map[argv[i]];
    if (!key) throw new Error(`Unknown argument ${argv[i]}`);
    if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value`);
    out[key] = ["fromBlock", "chunk", "concurrency", "chainId"].includes(key) ? Number(argv[i + 1]) : argv[i + 1];
  }
  return out;
}

/**
 * A minimal JSON-RPC provider with retry, shaped like the app's `{ request }`. Rate limits (HTTP
 * 429/5xx, an HTML error page instead of JSON, or a "rate/limit/busy" RPC error) are retried with
 * backoff; a real RPC error such as a revert is thrown at once.
 */
export function rpcProvider(url, { fetchImpl = globalThis.fetch, retries = 8, baseDelayMs = 400 } = {}) {
  let id = 0;
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  return {
    async request({ method, params = [] }) {
      for (let attempt = 0; ; attempt += 1) {
        let body;
        try {
          const response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
          const text = await response.text();
          if (response.status === 429 || response.status >= 500) throw Object.assign(new Error(`HTTP ${response.status}`), { retry: true });
          try { body = JSON.parse(text); } catch { throw Object.assign(new Error("the RPC returned a non-JSON response"), { retry: true }); }
        } catch (error) {
          if (!(error.retry || error instanceof TypeError) || attempt >= retries) throw error;
          await wait(baseDelayMs * 2 ** Math.min(attempt, 5));
          continue;
        }
        if (body.error) {
          const limited = /rate|limit|too many|timeout|busy/i.test(String(body.error.message)) && !/block range/i.test(String(body.error.message));
          if (limited && attempt < retries) { await wait(baseDelayMs * 2 ** Math.min(attempt, 5)); continue; }
          throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data });
        }
        return body.result;
      }
    },
  };
}

async function call(provider, to, iface, name, args = []) {
  const result = await provider.request({ method: "eth_call", params: [{ to, data: iface.encodeFunctionData(name, args) }, "latest"] });
  return iface.decodeFunctionResult(name, result)[0];
}

/**
 * Every ISSUER_ROLE grant and revoke on the release, replayed in order, so a minter added by an
 * artist-signed role change is found even when it is not one of the addresses we already know.
 */
export async function scanIssuerHolders(provider, { release, fromBlock, toBlock, chunk = 100, concurrency = 8 }) {
  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) ranges.push([start, Math.min(start + chunk - 1, toBlock)]);
  const logs = [];
  let next = 0;
  async function worker() {
    while (next < ranges.length) {
      const [start, end] = ranges[next++];
      const found = await provider.request({ method: "eth_getLogs", params: [{ address: release, fromBlock: ethers.toQuantity(start), toBlock: ethers.toQuantity(end), topics: [[RELEASE_ROLE_GRANTED, RELEASE_ROLE_REVOKED], ISSUER_ROLE] }] });
      logs.push(...found);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) || 1 }, worker));
  logs.sort((a, b) => (Number(a.blockNumber) - Number(b.blockNumber)) || (Number(a.logIndex) - Number(b.logIndex)));
  const holders = new Map();
  for (const entry of logs) {
    const account = ethers.getAddress(ethers.dataSlice(entry.topics[2], 12));
    if (lower(entry.topics[0]) === lower(RELEASE_ROLE_GRANTED)) holders.set(lower(account), account);
    else holders.delete(lower(account));
  }
  return { holders: [...holders.values()], events: logs.length, ranges: ranges.length };
}

export async function verifyActivation(provider, options, { onProgress = () => {} } = {}) {
  const sale = addr(options.sale);
  const release = addr(options.release);
  const factory = addr(options.factory);
  const oldSale = addr(options.oldSale);
  const artist = addr(options.artist);
  const platform = addr(options.platformRecipient);
  const checks = [];
  const record = (name, pass, detail = "") => { checks.push({ name, pass: Boolean(pass), detail }); onProgress(checks[checks.length - 1]); };
  const guard = async (name, fn) => { try { await fn(); } catch (error) { record(name, false, `read failed: ${error?.shortMessage || error?.message || error}`); } };
  if (!sale) throw new Error("--sale must be a valid address");

  await guard("chain is the expected chain", async () => {
    const chain = Number(BigInt(await provider.request({ method: "eth_chainId" })));
    record(`chain id is ${options.chainId}`, chain === Number(options.chainId), `rpc chain id ${chain}`);
  });

  const authorization = await verifyAuthorizedSale(provider, { sale, release, factory, expectedPlatformRecipient: platform, chainId: options.chainId });
  record("sale has contract code", authorization.details.codeHash !== null || !authorization.problems.some((p) => /no contract code/.test(p)), authorization.problems.find((p) => /no contract code/.test(p)) || "");
  record("sale runtime code is the reviewed VoidPrimarySaleSettled", authorization.details.codeHash === SETTLED_SALE_RUNTIME_CODE_HASH, `masked code hash ${authorization.details.codeHash ?? "n/a"}`);
  record("sale is authorized (release binding, platform wallet, 250 bps, no owner, ISSUER, factory-recognized release)", authorization.authorized && authorization.kind === "settled-satellite", authorization.problems.join(" ") || `kind ${authorization.kind}; platform recipient ${authorization.details.platformRecipient}; fee ${authorization.details.feeBps} bps`);

  await guard("old sale is not an issuer", async () => {
    const issuer = await call(provider, release, ifaces.release, "hasRole", [ISSUER_ROLE, oldSale]);
    record("old factory-made sale no longer holds ISSUER_ROLE (cannot mint)", !issuer, issuer ? `${oldSale} can still mint` : "revoked");
  });
  await guard("artist is not an issuer", async () => {
    const issuer = await call(provider, release, ifaces.release, "hasRole", [ISSUER_ROLE, artist]);
    record("artist wallet does not hold ISSUER_ROLE", !issuer, issuer ? `${artist} can mint outside the sale` : "not an issuer");
  });

  await guard("issuer scan", async () => {
    const head = Number(BigInt(await provider.request({ method: "eth_blockNumber" })));
    const scan = await scanIssuerHolders(provider, { release, fromBlock: options.fromBlock, toBlock: head, chunk: options.chunk, concurrency: options.concurrency });
    const others = scan.holders.filter((holder) => lower(holder) !== lower(sale));
    const hasSale = scan.holders.some((holder) => lower(holder) === lower(sale));
    record("the settled sale is the ONLY ISSUER_ROLE holder (all grants/revokes replayed)", hasSale && others.length === 0, others.length ? `unexpected minter(s): ${others.join(", ")}` : `${scan.events} role event(s) in ${scan.ranges} range(s); holders: ${scan.holders.join(", ") || "none"}`);
  });

  await guard("historical credits", async () => {
    const [held, artistCredit, platformCredit] = await Promise.all([
      provider.request({ method: "eth_getBalance", params: [oldSale, "latest"] }).then(BigInt),
      call(provider, oldSale, ifaces.sale, "balances", [artist]).then(BigInt),
      call(provider, oldSale, ifaces.sale, "balances", [platform]).then(BigInt),
    ]);
    record("old sale still holds at least every unwithdrawn credit (nothing lost)", held >= artistCredit + platformCredit, `holds ${ethers.formatEther(held)} AVAX; artist credit ${ethers.formatEther(artistCredit)}; platform credit ${ethers.formatEther(platformCredit)}`);
  });

  await guard("registry", async () => {
    const [isRelease, registered, registry, key] = await Promise.all([
      call(provider, factory, ifaces.factory, "isRelease", [release]),
      call(provider, factory, ifaces.factory, "primarySaleOf", [release]),
      call(provider, options.marketplace, ifaces.marketplace, "registry"),
      call(provider, release, ifaces.release, "releaseKey"),
    ]);
    record("factory still recognizes the existing release", Boolean(isRelease), `isRelease(${release}) = ${isRelease}`);
    record("factory registry is unchanged (still names the original sale)", lower(registered) === lower(oldSale), `primarySaleOf = ${registered}`);
    record("marketplace registry is still the factory", lower(registry) === lower(factory), `registry() = ${registry}`);
    record("release identity is readable (releaseKey)", /^0x[0-9a-f]{64}$/i.test(key) && !/^0x0+$/.test(key), `releaseKey ${key}`);
  });

  return { checks, pass: checks.every((check) => check.pass) };
}

async function main() {
  const manifest = JSON.parse(await readFile(resolve(ROOT, "config/mainnet-release-per-contract.json"), "utf8"));
  let options;
  try { options = parseArgs(process.argv.slice(2), manifest); } catch (error) { console.error(error.message); process.exit(2); }
  if (!options.rpc || !options.sale) { console.error("usage: --rpc <url> --sale <address> [--release --factory --old-sale --artist --platform-recipient --marketplace --from-block --chunk --concurrency]"); process.exit(2); }
  console.log(`Read-only activation check on ${options.rpc}\n  sale ${options.sale}\n  release ${options.release}\n  scanning role events from block ${options.fromBlock} in chunks of ${options.chunk}\n`);
  const result = await verifyActivation(rpcProvider(options.rpc), options, { onProgress: (check) => console.log(`${check.pass ? "PASS" : "FAIL"}  ${check.name}${check.detail ? `\n        ${check.detail}` : ""}`) });
  console.log(`\n${result.pass ? "ACTIVATION VERIFIED" : "NOT VERIFIED"}: ${result.checks.filter((c) => c.pass).length}/${result.checks.length} checks passed`);
  process.exit(result.pass ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
