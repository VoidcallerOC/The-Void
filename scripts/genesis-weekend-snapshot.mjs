// Read-only generator for the GenesisWeekendClaim eligibility snapshot.
//
//   node scripts/genesis-weekend-snapshot.mjs [--cchain-block N] [--out deploy/mainnet/genesis-weekend/snapshot.json]
//
// It reads Avalanche C-Chain at an exact block and The Grotto at the latest block not after it, applies the
// fail-closed rules in server/genesis-weekend-snapshot.js, and writes the snapshot only when every rule holds.
// The C-Chain transfer history comes from the Routescan explorer API and is used only as a candidate list:
// balances are read from the chain at the snapshot block, and the completeness rule rejects a list that
// misses any holder. It sends no transaction.
import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { Contract, Interface, JsonRpcProvider, getAddress } from "ethers";
import { computeWeekendSnapshot, GENESIS_TOKEN_IDS, GROTTO_WRAPPED, SNAPSHOT_FORMAT, SOURCE_BRIDGE, WEEKEND_RULE, WEEKEND_RULE_TEXT, ZERO } from "../server/genesis-weekend-snapshot.js";
import { WEEKEND_CAMPAIGN } from "../server/genesis-weekend-merkle.js";

export const CCHAIN_RPC = process.env.CCHAIN_RPC_URL || "https://api.avax.network/ext/bc/C/rpc";
export const GROTTO_RPC = process.env.GROTTO_RPC_URL || "https://subnets.avax.network/thegrotto/mainnet/rpc";
export const EXPLORER = "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api";
// Avalanche's own Glacier data API: a second indexer, independent of Routescan.
export const GLACIER = "https://glacier-api.avax.network/v1/chains/43114/tokens";
export const GENESIS = "0xD1B4367dd9f235f9ee61878019d66E31511E98eE";
export const PRIOR_CLAIMS = Object.freeze([
  "0x8512be04a4E54cd8551738165F9c05C3303187a0",
  "0x7D1a068F532aD6c0f591d4Fb9F82fd5b97495363",
  "0xd70dBA7fF6419481d62D4689bDf271ad441766b8",
]);
export const RECOVERY_CLAIM = PRIOR_CLAIMS[2];
const GENESIS_FIRST_BLOCK = 41_000_000;
const GROTTO_LOG_CHUNK = 2048;
const PAGE_SIZE = 100;

const TRANSFERS = new Interface([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
]);
const BRIDGE = new Interface([
  "event TokensBridged(address indexed sender, address indexed recipient, uint256[] tokenIds, uint256[] amounts, bytes32 messageID)",
  "event TokensUnlocked(address indexed recipient, uint256[] tokenIds, uint256[] amounts)",
]);
const CLAIMED = new Interface(["event GenesisHolderClaimed(address indexed claimant, address indexed releaseContract, uint256 indexed tokenId, uint256 quantity, uint256 nonce, bytes32 voucherHash)"]);
const BALANCES = ["function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])", "function balanceOf(address account, uint256 id) view returns (uint256)"];
const PRIOR = ["function hasClaimed(address) view returns (bool)", "function claimedSupply() view returns (uint256)"];

/** Applies one TransferSingle/TransferBatch log to holder candidates and per-id mints minus burns. */
export function applyTransfer(parsed, candidates, issued) {
  const pairs = parsed.name === "TransferSingle" ? [[parsed.args[3], parsed.args[4]]] : parsed.args[3].map((tokenId, i) => [tokenId, parsed.args[4][i]]);
  const from = getAddress(parsed.args[1]);
  const to = getAddress(parsed.args[2]);
  if (from !== ZERO) candidates.add(from);
  if (to !== ZERO) candidates.add(to);
  for (const [tokenId, value] of pairs) {
    const index = Number(tokenId);
    if (!GENESIS_TOKEN_IDS.includes(index)) continue;
    if (from === ZERO) issued[index] += BigInt(value);
    if (to === ZERO) issued[index] -= BigInt(value);
  }
}

export async function explorerLogs({ address, fromBlock, toBlock, fetchImpl = fetch }) {
  // Routescan pages at PAGE_SIZE logs per call; split the range until each window fits in one page.
  const logs = [];
  const windows = [[fromBlock, toBlock]];
  while (windows.length) {
    const [from, to] = windows.shift();
    const url = `${EXPLORER}?module=logs&action=getLogs&address=${address}&fromBlock=${from}&toBlock=${to}&page=1&offset=${PAGE_SIZE}`;
    const body = await withRetry(async () => (await fetchImpl(url)).json(), { paceMs: 250 });
    const result = Array.isArray(body.result) ? body.result : [];
    if (body.status !== "1" && result.length === 0 && !/No records/i.test(String(body.message))) throw new Error(`Explorer error for ${address} ${from}-${to}: ${body.message}`);
    if (result.length >= PAGE_SIZE) {
      if (from === to) throw new Error(`At least ${PAGE_SIZE} logs in block ${from}; cannot page.`);
      const mid = Math.floor((from + to) / 2);
      windows.unshift([mid + 1, to]);
      windows.unshift([from, mid]);
      continue;
    }
    logs.push(...result);
  }
  return logs;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Paced and retried RPC read: public endpoints throttle bursts (HTTP 429 / Cloudflare 1015). */
export async function withRetry(operation, { attempts = 8, baseMs = 500, paceMs = 120 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    await sleep(paceMs);
    try {
      return await operation();
    } catch (error) {
      const text = `${error?.shortMessage || ""} ${error?.message || ""} ${error?.info?.responseStatus || ""}`;
      if (attempt >= attempts || !/429|1015|Too Many|rate|timeout|retry limit|SERVER_ERROR|ECONNRESET/i.test(text)) throw error;
      await sleep(baseMs * 2 ** (attempt - 1));
    }
  }
}

async function inBatches(items, size, task) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(task)));
  return out;
}

/**
 * Every Genesis transfer Glacier has indexed up to `toBlock`: candidate addresses and per-id mints minus burns.
 * Batch transfers appear once per token id, so entries are keyed by transaction, log, token and parties.
 */
export async function glacierIssuance({ address, toBlock, fetchImpl = fetch }) {
  const candidates = new Set();
  const issued = [0n, 0n, 0n, 0n];
  const seen = new Set();
  let pageToken = "";
  for (let page = 0; page < 1000; page += 1) {
    const url = `${GLACIER}/${address}/transfers?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const body = await withRetry(async () => {
      const response = await fetchImpl(url);
      if (!response.ok) throw Object.assign(new Error(`Glacier HTTP ${response.status}`), { code: response.status === 429 ? "SERVER_ERROR" : "GLACIER_ERROR" });
      return response.json();
    }, { paceMs: 250 });
    for (const entry of body.transfers || []) {
      if (Number(entry.blockNumber) > toBlock) continue;
      const tokenId = Number(entry.erc1155Token?.tokenId);
      const from = getAddress(entry.from.address);
      const to = getAddress(entry.to.address);
      const key = `${String(entry.txHash).toLowerCase()}:${entry.logIndex}:${tokenId}:${from}:${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (from !== ZERO) candidates.add(from);
      if (to !== ZERO) candidates.add(to);
      if (!GENESIS_TOKEN_IDS.includes(tokenId)) continue;
      if (from === ZERO) issued[tokenId] += BigInt(entry.value);
      if (to === ZERO) issued[tokenId] -= BigInt(entry.value);
    }
    if (!body.nextPageToken) return { candidates, issued, transfers: seen.size };
    pageToken = body.nextPageToken;
  }
  throw new Error("Glacier pagination did not terminate.");
}

/** A Genesis transfer log from either the explorer (hex fields) or the node (numeric fields). */
export function normalizeTransfer(raw) {
  let parsed;
  try { parsed = TRANSFERS.parseLog({ topics: raw.topics, data: raw.data }); } catch { return null; }
  if (!parsed) return null;
  const blockNumber = typeof raw.blockNumber === "string" ? Number.parseInt(raw.blockNumber, raw.blockNumber.startsWith("0x") ? 16 : 10) : Number(raw.blockNumber);
  const logIndex = raw.index ?? raw.logIndex;
  const index = typeof logIndex === "string" ? Number.parseInt(logIndex, logIndex.startsWith("0x") ? 16 : 10) : Number(logIndex);
  return { key: `${String(raw.transactionHash).toLowerCase()}:${index}`, blockNumber, parsed };
}

/** Balance of `wallet` for each Genesis id implied by the known transfers up to and including `block`. */
export function impliedBalances(transfers, wallet, block) {
  const out = [0n, 0n, 0n, 0n];
  for (const { blockNumber, parsed } of transfers.values()) {
    if (blockNumber > block) continue;
    const from = getAddress(parsed.args[1]);
    const to = getAddress(parsed.args[2]);
    if (from !== wallet && to !== wallet) continue;
    const pairs = parsed.name === "TransferSingle" ? [[parsed.args[3], parsed.args[4]]] : parsed.args[3].map((tokenId, i) => [tokenId, parsed.args[4][i]]);
    for (const [tokenId, value] of pairs) {
      const id = Number(tokenId);
      if (!GENESIS_TOKEN_IDS.includes(id)) continue;
      if (from === wallet) out[id] -= BigInt(value);
      if (to === wallet) out[id] += BigInt(value);
    }
  }
  return out;
}

/**
 * Repairs transfers the explorer missed. For every known address whose on-chain balance at the snapshot
 * disagrees with its known history, binary-search the first block where they diverge and add that block's
 * transfer logs read from the C-Chain node. New counterparties join the address set, so a holder the
 * explorer never reported is found. Fails after `maxRepairs` blocks rather than looping.
 */
export async function repairExplorerGaps({ transfers, snapshotBlock, readBalances, readBlockLogs, log = () => {}, maxRepairs = 64, firstBlock = GENESIS_FIRST_BLOCK }) {
  const repaired = [];
  const checked = new Map();
  for (;;) {
    const addresses = new Set([getAddress(SOURCE_BRIDGE)]);
    for (const { parsed } of transfers.values()) {
      for (const address of [parsed.args[1], parsed.args[2]]) if (getAddress(address) !== ZERO) addresses.add(getAddress(address));
    }
    let mismatch = null;
    for (const wallet of addresses) {
      const implied = impliedBalances(transfers, wallet, snapshotBlock);
      const signature = implied.join(",");
      if (checked.get(wallet) === signature) continue;
      const actual = (await readBalances(wallet, snapshotBlock)).map((value) => BigInt(value));
      if (actual.every((value, id) => value === implied[id])) { checked.set(wallet, signature); continue; }
      mismatch = { wallet, actual, implied };
      break;
    }
    if (!mismatch) return repaired;
    if (repaired.length >= maxRepairs) throw new Error(`Explorer history still disagrees with the chain after ${maxRepairs} repairs.`);
    let low = firstBlock;
    let high = snapshotBlock;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const actual = (await readBalances(mismatch.wallet, mid)).map((value) => BigInt(value));
      const implied = impliedBalances(transfers, mismatch.wallet, mid);
      if (actual.every((value, id) => value === implied[id])) low = mid + 1; else high = mid;
    }
    let added = 0;
    for (const raw of await readBlockLogs(low)) {
      const transfer = normalizeTransfer(raw);
      if (transfer && !transfers.has(transfer.key)) { transfers.set(transfer.key, transfer); added += 1; }
    }
    if (!added) throw new Error(`Balance of ${mismatch.wallet} diverges at block ${low}, but the node reports no missing Genesis transfer there.`);
    repaired.push({ wallet: mismatch.wallet, block: low, logsAdded: added });
    log(`repaired explorer gap: ${mismatch.wallet} at block ${low} (+${added} log)`);
  }
}

async function grottoBlockAtOrBefore(provider, timestamp) {
  let low = 0;
  let high = await withRetry(() => provider.getBlockNumber());
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((await withRetry(() => provider.getBlock(mid))).timestamp <= timestamp) low = mid; else high = mid - 1;
  }
  return withRetry(() => provider.getBlock(low));
}

export async function generateSnapshot({ cchainBlock, historicalClaimsFile = "deploy/mainnet/genesis-weekend/historical-claims.json", log = console.error } = {}) {
  const cchain = new JsonRpcProvider(CCHAIN_RPC, 43114, { staticNetwork: true, batchMaxCount: 20 });
  const grotto = new JsonRpcProvider(GROTTO_RPC, 36463, { staticNetwork: true, batchMaxCount: 20 });
  if (Number((await cchain.send("eth_chainId", [])).toString()) !== 43114) throw new Error("C-Chain RPC is not chain 43114.");
  if (Number((await grotto.send("eth_chainId", [])).toString()) !== 36463) throw new Error("Grotto RPC is not chain 36463.");

  const cHead = await cchain.getBlock("latest");
  const cBlock = await cchain.getBlock(cchainBlock ?? cHead.number - 7200);
  const gBlock = await grottoBlockAtOrBefore(grotto, cBlock.timestamp);
  // The Grotto only produces blocks on activity. Its state is constant from gBlock until the next block,
  // so the snapshot is consistent when no Grotto block exists between gBlock and the C-Chain snapshot.
  const gHeadAtStart = await withRetry(() => grotto.getBlockNumber());
  const gNext = gBlock.number < gHeadAtStart ? await withRetry(() => grotto.getBlock(gBlock.number + 1)) : null;
  log(`snapshot: C-Chain ${cBlock.number} (${new Date(cBlock.timestamp * 1000).toISOString()}), Grotto ${gBlock.number} (${new Date(gBlock.timestamp * 1000).toISOString()})`);

  // C-Chain candidates and issuance from the full Genesis transfer history up to the snapshot block. The
  // explorer is only a candidate source: any address whose on-chain balance disagrees with its explorer
  // history is repaired from the C-Chain node itself (see repairExplorerGaps), and the completeness rule
  // still refuses the snapshot if anything remains unexplained.
  const genesis = new Contract(GENESIS, BALANCES, cchain);
  const cTransfers = new Map();
  for (const raw of await explorerLogs({ address: GENESIS, fromBlock: GENESIS_FIRST_BLOCK, toBlock: cBlock.number })) {
    const transfer = normalizeTransfer(raw);
    if (transfer) cTransfers.set(transfer.key, transfer);
  }
  const explorerTransferCount = cTransfers.size;
  const readBalances = (wallet, blockTag) => withRetry(() => genesis.balanceOfBatch([wallet, wallet, wallet, wallet], GENESIS_TOKEN_IDS, { blockTag }), { paceMs: 20 });
  const repairs = await repairExplorerGaps({ transfers: cTransfers, snapshotBlock: cBlock.number, readBalances, readBlockLogs: (block) => withRetry(() => cchain.getLogs({ address: GENESIS, fromBlock: block, toBlock: block })), log });
  const cCandidates = new Set([getAddress(SOURCE_BRIDGE)]);
  const cIssued = [0n, 0n, 0n, 0n];
  for (const transfer of cTransfers.values()) applyTransfer(transfer.parsed, cCandidates, cIssued);
  // Second, independent indexer: its addresses join the candidates and its issuance must match.
  const glacier = await glacierIssuance({ address: GENESIS, toBlock: cBlock.number });
  for (const wallet of glacier.candidates) cCandidates.add(wallet);
  log(`Glacier: ${glacier.transfers} transfers, issuance ${glacier.issued.join("/")} vs explorer+node ${cIssued.join("/")}`);
  log(`C-Chain: ${explorerTransferCount} explorer transfer logs, ${repairs.length} repaired from the node, ${cCandidates.size} candidate addresses; reading balances`);
  const cBalances = new Map();
  await inBatches([...cCandidates], 20, async (wallet) => {
    cBalances.set(wallet, (await readBalances(wallet, cBlock.number)).map((value) => value.toString()));
  });

  // Grotto candidates and issuance from the wrapped collection's full history, read from the Grotto node.
  const gCandidates = new Set();
  const gIssued = [0n, 0n, 0n, 0n];
  const topics = [[TRANSFERS.getEvent("TransferSingle").topicHash, TRANSFERS.getEvent("TransferBatch").topicHash]];
  for (let from = 0; from <= gBlock.number; from += GROTTO_LOG_CHUNK) {
    const to = Math.min(from + GROTTO_LOG_CHUNK - 1, gBlock.number);
    for (const raw of await withRetry(() => grotto.getLogs({ address: GROTTO_WRAPPED, topics, fromBlock: from, toBlock: to }))) applyTransfer(TRANSFERS.parseLog(raw), gCandidates, gIssued);
  }
  const wrapped = new Contract(GROTTO_WRAPPED, BALANCES, grotto);
  const gBalances = new Map();
  await inBatches([...gCandidates], 1, async (wallet) => {
    const values = [];
    for (const tokenId of GENESIS_TOKEN_IDS) values.push(await withRetry(() => wrapped.balanceOf(wallet, tokenId, { blockTag: gBlock.number })));
    gBalances.set(wallet, values.map((value) => value.toString()));
  });
  log(`Grotto: ${gCandidates.size} candidate addresses; reading bridge activity and claims`);

  // Bridge activity from the quiet window's start to now, on both chains.
  const quietStart = Math.min(cBlock.timestamp, gBlock.timestamp) - 1800;
  const bridgeActivity = [];
  for (const raw of await explorerLogs({ address: SOURCE_BRIDGE, fromBlock: cBlock.number - 3000, toBlock: cHead.number })) {
    let parsed;
    try { parsed = BRIDGE.parseLog({ topics: raw.topics, data: raw.data }); } catch { continue; }
    if (parsed && Number.parseInt(raw.timeStamp, 16) >= quietStart) bridgeActivity.push({ chain: "c-chain", kind: parsed.name, transactionHash: raw.transactionHash, timestamp: Number.parseInt(raw.timeStamp, 16) });
  }
  const gHead = await withRetry(() => grotto.getBlockNumber());
  for (let from = Math.max(0, gBlock.number - 3000); from <= gHead; from += GROTTO_LOG_CHUNK) {
    const to = Math.min(from + GROTTO_LOG_CHUNK - 1, gHead);
    for (const raw of await withRetry(() => grotto.getLogs({ address: GROTTO_WRAPPED, topics, fromBlock: from, toBlock: to }))) {
      const parsed = TRANSFERS.parseLog(raw);
      const mintOrBurn = getAddress(parsed.args[1]) === ZERO || getAddress(parsed.args[2]) === ZERO;
      const timestamp = (await withRetry(() => grotto.getBlock(raw.blockNumber))).timestamp;
      if (mintOrBurn && timestamp >= quietStart) bridgeActivity.push({ chain: "grotto", kind: getAddress(parsed.args[1]) === ZERO ? "mint" : "burn", transactionHash: raw.transactionHash, timestamp });
    }
  }
  if (Math.max(cBlock.timestamp, gBlock.timestamp) + 1800 > cHead.timestamp) throw new Error("The quiet window after the snapshot has not elapsed; choose an older snapshot block.");

  // Historical claims, verified on-chain at the snapshot block.
  const fileClaims = JSON.parse(fs.readFileSync(historicalClaimsFile, "utf8")).claims;
  const historicalClaims = [];
  for (const record of fileClaims) {
    const receipt = await cchain.getTransactionReceipt(record.transactionHash);
    const ok = receipt && receipt.status === 1 && receipt.blockNumber <= cBlock.number && receipt.logs.some((entry) => {
      if (getAddress(entry.address) !== getAddress(record.claimContract)) return false;
      try { const parsed = CLAIMED.parseLog(entry); return parsed && getAddress(parsed.args.claimant) === getAddress(record.wallet); } catch { return false; }
    });
    if (!ok) throw new Error(`Historical claim ${record.transactionHash} is not a confirmed claim by ${record.wallet} on ${record.claimContract}.`);
    historicalClaims.push({ ...record, wallet: getAddress(record.wallet) });
  }
  const priors = PRIOR_CLAIMS.map((address) => new Contract(address, PRIOR, cchain));
  const everyWallet = [...new Set([...cBalances.keys(), ...gBalances.keys(), ...historicalClaims.map(({ wallet }) => wallet)])];
  const priorClaimants = new Set();
  await inBatches(everyWallet, 10, async (wallet) => {
    const flags = await Promise.all(priors.map((prior) => withRetry(() => prior.hasClaimed(wallet, { blockTag: cBlock.number }), { paceMs: 20 })));
    if (flags.some(Boolean)) priorClaimants.add(wallet);
  });
  const historicalClaimedSupply = await new Contract(RECOVERY_CLAIM, PRIOR, cchain).claimedSupply({ blockTag: cBlock.number });

  const result = computeWeekendSnapshot({
    cchain: { block: cBlock.number, blockHash: cBlock.hash, timestamp: cBlock.timestamp, balances: cBalances, mintsMinusBurns: cIssued, independentMintsMinusBurns: glacier.issued },
    grotto: { block: gBlock.number, blockHash: gBlock.hash, timestamp: gBlock.timestamp, nextBlockTimestamp: gNext ? gNext.timestamp : null, balances: gBalances, mintsMinusBurns: gIssued },
    priorClaimants, historicalClaimedSupply, historicalClaims, bridgeActivity,
  });
  // Informational: an allowlisted contract address (a multisig, say) can claim only if it can call claim().
  const contractWallets = [];
  await inBatches(result.eligible.map(({ wallet }) => wallet), 20, async (wallet) => {
    if ((await withRetry(() => cchain.getCode(wallet, cBlock.number), { paceMs: 20 })) !== "0x") contractWallets.push(wallet);
  });
  return {
    format: SNAPSHOT_FORMAT,
    campaign: WEEKEND_CAMPAIGN,
    eligibilityRule: WEEKEND_RULE,
    eligibilityRuleText: WEEKEND_RULE_TEXT,
    generatedAt: new Date(cHead.timestamp * 1000).toISOString(),
    cchain: { chainId: 43114, block: cBlock.number, blockHash: cBlock.hash, timestamp: cBlock.timestamp, explorerTransferLogs: explorerTransferCount, transferLogs: cTransfers.size, explorerGapsRepaired: repairs, glacierTransfers: glacier.transfers, candidates: cCandidates.size },
    grotto: { chainId: 36463, block: gBlock.number, blockHash: gBlock.hash, timestamp: gBlock.timestamp, nextBlockTimestamp: gNext ? gNext.timestamp : null, candidates: gCandidates.size },
    priorClaims: PRIOR_CLAIMS,
    historicalClaimedSupply: historicalClaimedSupply.toString(),
    historicalClaims,
    ok: result.ok,
    failures: result.failures,
    reconciliation: result.reconciliation,
    merkleRoot: result.root ?? null,
    snapshotHash: result.snapshotHash ?? null,
    eligibleWallets: result.eligibleWallets ?? 0,
    eligibleContractWallets: contractWallets.sort(),
    eligible: result.eligible,
    excluded: result.excluded,
  };
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cchainBlock = argValue("--cchain-block") ? Number(argValue("--cchain-block")) : undefined;
  const out = argValue("--out");
  const snapshot = await generateSnapshot({ cchainBlock });
  const text = `${JSON.stringify(snapshot, (key, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`;
  if (out) fs.writeFileSync(out, text); else process.stdout.write(text);
  console.error(snapshot.ok ? `OK: ${snapshot.eligibleWallets} eligible wallets, root ${snapshot.merkleRoot}` : `REFUSED:\n- ${snapshot.failures.join("\n- ")}`);
  process.exitCode = snapshot.ok ? 0 : 1;
}
