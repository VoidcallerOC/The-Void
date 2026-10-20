#!/usr/bin/env node
// Read-only reconciliation of The Void's three revenue flows from CHAIN data only. It never signs,
// never sends a transaction and never reads a database. Every figure is derived from logs and live
// calls, and allocations (what a contract says is owed) are kept apart from transfers (AVAX that
// actually reached a wallet) and from balances (AVAX still sitting in a contract).
//
//   node scripts/payment-ledger-reconcile.mjs --rpc https://api.avax.network/ext/bc/C/rpc \
//     [--sale 0x6ae8…] [--settled-sale 0x…] [--marketplace 0x0e77…] [--release 0x9Aa6…] \
//     [--from-block 97932485] [--chunk 100] [--json]
//
// Flows:
//   1. "Mint revenue" == primary-sale revenue. The release's mint() is non-payable (proved by
//      eth_call), so no AVAX can be paid at mint except through a sale contract's purchase().
//   2. Primary sales: Purchased allocations vs PlatformPaid transfers vs Withdrawn transfers vs the
//      contract's native balance and live credits.
//   3. Secondary sales: ListingSold (price, platformFee, royalty, seller remainder). The marketplace
//      pushes every share inside buy() and must hold no AVAX.
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Interface, JsonRpcProvider, formatEther, getAddress, id } from "ethers";

export const MAINNET = Object.freeze({
  chainId: 43114,
  release: "0x9Aa6165B493ac50d0F8CDee2fD48a3C5155FD103",
  sale: "0x6ae84a51f100f10f0535a514555043ae9edf9aa3",
  marketplace: "0x0e77116142844478a55EEd2Ab79de9F93770F8f5",
  factory: "0x262B774cf9a1949170B58E2d57F6189980FE757b",
  platform: "0xb65C575CaE01574296Fab6E620B9A15cC0121ce4",
  fromBlock: 97932485,
});

const SALE = new Interface([
  "event Purchased(uint256 indexed tokenId, address indexed buyer, uint256 qty, uint256 paid, uint256 artistCut, uint256 platformCut)",
  "event PlatformPaid(address indexed recipient, uint256 amount)",
  "event Withdrawn(address indexed account, uint256 amount)",
  "function balances(address) view returns (uint256)",
  "function platformRecipient() view returns (address)",
  "function releases() view returns (address)",
]);
const MARKET = new Interface([
  "event ListingSold(uint256 indexed listingId, address indexed buyer, address indexed seller, address tokenContract, uint256 tokenId, uint256 amount, uint256 price, uint256 platformFee, uint256 royalty)",
]);
const RELEASE = new Interface([
  "function payoutOf(uint256 tokenId) view returns (address)",
  "function mint(address to, uint256 tokenId, uint256 amount, bytes data)",
]);

const sum = (rows, key) => rows.reduce((total, row) => total + BigInt(row[key]), 0n);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
/** Addresses arrive in any casing (a mis-cased checksum is not a different address); normalise via lowercase. */
const norm = (value) => getAddress(String(value).toLowerCase());

/** eth_getLogs in bounded windows (public C-Chain RPCs cap the range). */
export async function getLogsChunked(provider, filter, fromBlock, toBlock, { chunk = 100, concurrency = 6 } = {}) {
  const windows = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) windows.push([start, Math.min(start + chunk - 1, toBlock)]);
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < windows.length) {
      const [from, to] = windows[next++];
      for (let attempt = 0; ; attempt += 1) {
        try { out.push(...(await provider.getLogs({ ...filter, fromBlock: from, toBlock: to }))); break; } catch (error) {
          if (attempt >= 4) throw error;
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
}

/** Pure: reconcile one primary-sale contract from its decoded logs and live reads. */
export function reconcilePrimarySale({ saleAddress, platformRecipient, payouts, purchased, platformPaid, withdrawn, nativeBalance, credits }) {
  const gross = sum(purchased, "paid");
  const artistAllocation = sum(purchased, "artistCut");
  const platformAllocation = sum(purchased, "platformCut");
  const platformTransferred = sum(platformPaid, "amount");
  const platformWithdrawn = withdrawn.filter((row) => same(row.account, platformRecipient)).reduce((total, row) => total + BigInt(row.amount), 0n);
  const artistWithdrawn = withdrawn.filter((row) => !same(row.account, platformRecipient)).reduce((total, row) => total + BigInt(row.amount), 0n);
  const artistClaimable = credits.artist;
  const platformHeld = credits.platform;
  const expectedHeld = gross - platformTransferred - platformWithdrawn - artistWithdrawn;
  const problems = [];
  if (artistAllocation + platformAllocation !== gross) problems.push("allocations do not sum to gross revenue");
  if (nativeBalance !== expectedHeld) problems.push(`contract balance ${nativeBalance} differs from gross minus transfers ${expectedHeld}`);
  if (artistClaimable !== artistAllocation - artistWithdrawn) problems.push(`artist claimable ${artistClaimable} differs from allocation minus withdrawals ${artistAllocation - artistWithdrawn}`);
  const platformOwedInContract = platformAllocation - platformTransferred - platformWithdrawn;
  if (platformHeld !== platformOwedInContract) problems.push(`platform credit held ${platformHeld} differs from allocation minus transfers ${platformOwedInContract}`);
  return {
    saleAddress, purchases: purchased.length, gross,
    artist: { allocation: artistAllocation, withdrawnToWallet: artistWithdrawn, claimableNow: artistClaimable, payouts },
    platform: { allocation: platformAllocation, transferredToWallet: platformTransferred + platformWithdrawn, pushedAtPurchase: platformTransferred, withdrawnByPlatformWallet: platformWithdrawn, heldAsContractCredit: platformHeld },
    heldInContract: nativeBalance, expectedHeldInContract: expectedHeld, problems,
  };
}

/** Pure: reconcile the marketplace from ListingSold rows. */
export function reconcileSecondary({ sold, nativeBalance, royaltyReceivers = [] }) {
  const gross = sum(sold, "price");
  const platform = sum(sold, "platformFee");
  const royalty = sum(sold, "royalty");
  const seller = gross - platform - royalty;
  const problems = [];
  if (nativeBalance !== 0n) problems.push(`marketplace holds ${nativeBalance} wei; it must hold none because every share is pushed inside buy()`);
  for (const row of sold) {
    const price = BigInt(row.price);
    if (BigInt(row.platformFee) !== (price * 250n) / 10000n) problems.push(`listing ${row.listingId}: platform fee is not 2.5%`);
    if (BigInt(row.royalty) !== (price * 250n) / 10000n) problems.push(`listing ${row.listingId}: royalty is not 2.5%`);
  }
  return { sales: sold.length, gross, sellerProceeds: seller, artistRoyalty: royalty, platformFee: platform, royaltyReceivers, heldInContract: nativeBalance, problems };
}

async function call(provider, to, iface, name, args = []) {
  const raw = await provider.call({ to, data: iface.encodeFunctionData(name, args) });
  return iface.decodeFunctionResult(name, raw)[0];
}

/** Logs for an address from a supplied explorer export when given, else from the RPC. Records the source. */
async function logsFor(provider, config, filter, fromBlock, toBlock) {
  const supplied = config.logsByAddress?.[String(filter.address).toLowerCase()];
  if (supplied) {
    const wanted = filter.topics?.[0]?.toLowerCase();
    const rows = supplied.filter((log) => !wanted || String(log.topics?.[0]).toLowerCase() === wanted).map((log) => ({ ...log, blockNumber: Number(log.blockNumber), index: Number(log.logIndex ?? log.index ?? 0) }));
    return { logs: rows, source: "supplied explorer export (--logs-file)" };
  }
  return { logs: await getLogsChunked(provider, filter, fromBlock, toBlock, config.logOptions), source: "RPC eth_getLogs" };
}

export async function reconcileChain(provider, config) {
  const latest = await provider.getBlockNumber();
  const chainId = Number((await provider.getNetwork()).chainId);
  config = { ...config, release: norm(config.release), marketplace: norm(config.marketplace), sales: config.sales.map(norm), sale: norm(config.sale) };
  const report = { chainId, latestBlock: latest, flows: {} };

  // 1. Mint revenue: prove mint() cannot carry AVAX, and that the release holds none.
  const probeTo = "0x00000000000000000000000000000000000000b1";
  const data = RELEASE.encodeFunctionData("mint", [probeTo, 1n, 1n, "0x"]);
  const sender = config.sale;
  let rejectsValue = false;
  try { await provider.call({ from: sender, to: config.release, data, value: 1n }); } catch { rejectsValue = true; }
  report.flows.mint = {
    description: "Mint revenue is primary-sale revenue: release.mint() is non-payable, so no AVAX can be paid at mint except through a sale contract's purchase().",
    mintRejectsAttachedAvax: rejectsValue,
    releaseNativeBalance: await provider.getBalance(config.release),
    problems: [...(rejectsValue ? [] : ["release.mint() accepted attached AVAX"]), ...((await provider.getBalance(config.release)) === 0n ? [] : ["release contract holds AVAX"])],
  };

  // 2. Primary sales.
  report.flows.primary = [];
  for (const sale of config.sales) {
    const { logs, source } = await logsFor(provider, config, { address: sale }, config.fromBlock, latest);
    const decoded = logs.map((log) => ({ log, parsed: (() => { try { return SALE.parseLog(log); } catch { return null; } })() })).filter((row) => row.parsed);
    const purchased = decoded.filter((row) => row.parsed.name === "Purchased").map(({ log, parsed }) => ({ paid: parsed.args.paid, artistCut: parsed.args.artistCut, platformCut: parsed.args.platformCut, tokenId: parsed.args.tokenId, tx: log.transactionHash, block: log.blockNumber }));
    const platformPaid = decoded.filter((row) => row.parsed.name === "PlatformPaid").map(({ log, parsed }) => ({ recipient: parsed.args.recipient, amount: parsed.args.amount, tx: log.transactionHash }));
    const withdrawn = decoded.filter((row) => row.parsed.name === "Withdrawn").map(({ log, parsed }) => ({ account: parsed.args.account, amount: parsed.args.amount, tx: log.transactionHash }));
    const recipient = await call(provider, sale, SALE, "platformRecipient");
    const payouts = [];
    for (const row of purchased) {
      const payout = await call(provider, config.release, RELEASE, "payoutOf", [row.tokenId]);
      if (!payouts.some((p) => same(p, payout))) payouts.push(getAddress(payout));
    }
    const artist = payouts[0] ? await call(provider, sale, SALE, "balances", [payouts[0]]) : 0n;
    const platform = await call(provider, sale, SALE, "balances", [recipient]);
    const entry = reconcilePrimarySale({ saleAddress: getAddress(sale), platformRecipient: getAddress(recipient), payouts, purchased, platformPaid, withdrawn, nativeBalance: await provider.getBalance(sale), credits: { artist, platform } });
    entry.logSource = source;
    entry.transactions = { purchases: purchased.map((row) => row.tx), platformTransfers: platformPaid.map((row) => row.tx), withdrawals: withdrawn.map((row) => row.tx) };
    report.flows.primary.push(entry);
  }

  // 3. Secondary sales.
  const soldTopic = id("ListingSold(uint256,address,address,address,uint256,uint256,uint256,uint256,uint256)");
  const { logs: marketLogs, source: marketSource } = await logsFor(provider, config, { address: config.marketplace, topics: [soldTopic] }, config.marketplaceFromBlock, latest);
  const sold = marketLogs.map((log) => { const parsed = MARKET.parseLog(log); return { listingId: parsed.args.listingId, price: parsed.args.price, platformFee: parsed.args.platformFee, royalty: parsed.args.royalty, tx: log.transactionHash }; });
  report.flows.secondary = { ...reconcileSecondary({ sold, nativeBalance: await provider.getBalance(config.marketplace) }), logSource: marketSource };
  return report;
}

const fmt = (wei) => `${formatEther(BigInt(wei))} AVAX`;

export function renderReport(report) {
  const lines = [`Chain ${report.chainId}, latest block ${report.latestBlock} (read-only; allocations, transfers and balances are separate)`, ""];
  const mint = report.flows.mint;
  lines.push("FLOW 1  Mint revenue", `  ${mint.description}`, `  mint() rejects attached AVAX: ${mint.mintRejectsAttachedAvax}   release balance: ${fmt(mint.releaseNativeBalance)}`, `  Problems: ${mint.problems.length ? mint.problems.join("; ") : "none"}`, "");
  for (const sale of report.flows.primary) {
    lines.push(`FLOW 2  Primary sales  ${sale.saleAddress}  (${sale.purchases} purchase${sale.purchases === 1 ? "" : "s"}; logs: ${sale.logSource})`,
      `  1 Gross revenue received          ${fmt(sale.gross)}`,
      `  2 Artist allocation               ${fmt(sale.artist.allocation)}`,
      `  3 Platform allocation             ${fmt(sale.platform.allocation)}`,
      `  5 Transferred to platform wallet  ${fmt(sale.platform.transferredToWallet)}  (pushed at purchase ${fmt(sale.platform.pushedAtPurchase)}, withdrawn by platform wallet ${fmt(sale.platform.withdrawnByPlatformWallet)})`,
      `  5 Transferred to artist wallet    ${fmt(sale.artist.withdrawnToWallet)}  (artist withdrawals)`,
      `  6 Still held by the contract      ${fmt(sale.heldInContract)}  (platform credit ${fmt(sale.platform.heldAsContractCredit)} + artist claimable ${fmt(sale.artist.claimableNow)})`,
      `  7 Claimable by the artist now     ${fmt(sale.artist.claimableNow)}`,
      `  8 Withdrawn by the artist         ${fmt(sale.artist.withdrawnToWallet)}`,
      `  9 Discrepancies                   ${sale.problems.length ? sale.problems.join("; ") : "none"}`, "");
  }
  const s = report.flows.secondary;
  lines.push(`FLOW 3  Secondary sales  (${s.sales} sale${s.sales === 1 ? "" : "s"}; logs: ${s.logSource})`,
    `  1 Gross revenue received          ${fmt(s.gross)}`,
    `  4 Seller allocation               ${fmt(s.sellerProceeds)}`,
    `  2 Artist royalty                  ${fmt(s.artistRoyalty)}`,
    `  3 Platform fee                    ${fmt(s.platformFee)}  (pushed to the fee recipient inside buy())`,
    `  6 Still held by the marketplace   ${fmt(s.heldInContract)}`,
    `  9 Discrepancies                   ${s.problems.length ? s.problems.join("; ") : "none"}`);
  return lines.join("\n");
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const provider = new JsonRpcProvider(arg("rpc", "https://api.avax.network/ext/bc/C/rpc"), undefined, { staticNetwork: true, batchMaxCount: 1 });
  const sales = [arg("sale", MAINNET.sale), ...(arg("settled-sale") ? [arg("settled-sale")] : [])];
  const report = await reconcileChain(provider, {
    release: arg("release", MAINNET.release), sales, marketplace: arg("marketplace", MAINNET.marketplace),
    fromBlock: Number(arg("from-block", MAINNET.fromBlock)), marketplaceFromBlock: Number(arg("marketplace-from-block", 97619978)),
    sale: sales[0], logsByAddress: arg("logs-file") ? JSON.parse((await import("node:fs")).readFileSync(arg("logs-file"), "utf8")) : undefined, logOptions: { chunk: Number(arg("chunk", 100)), concurrency: Number(arg("concurrency", 6)) },
  });
  const json = process.argv.includes("--json");
  console.log(json ? JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) : renderReport(report));
  const failed = [report.flows.mint.problems, ...report.flows.primary.map((s) => s.problems), report.flows.secondary.problems].some((p) => p.length);
  process.exit(failed ? 1 : 0);
}
