// Deterministic, fail-closed eligibility snapshot for GenesisWeekendClaim.
//
// Eligible: a wallet holding Genesis 0..3 on Avalanche C-Chain, or wrapped Genesis 0..3 on The Grotto, at the
// snapshot blocks, that has not claimed through any earlier Genesis claim contract. One entry per wallet.
//
// Integrity rules (any failure refuses the snapshot):
// 1. C-Chain completeness: per token id, the snapshot balances of every address seen in the transfer history
//    (bridge custody included) sum to mints minus burns. A missing holder makes the sums disagree.
// 2. Cross-chain conservation: per token id, the C-Chain bridge custody equals the Grotto wrapped balances,
//    which equal Grotto mints minus burns. A unit in flight (locked but not yet minted, or burned but not yet
//    released) breaks the equality, so one unit can never be counted on both chains or for two wallets.
// 3. Same moment, quiet bridge: the Grotto block is the last one at or before the C-Chain snapshot time (The
//    Grotto only produces blocks on activity, so its state is constant until its next block), and no bridge
//    deposit, release, Grotto mint or burn happened within the quiet window around both snapshot timestamps.
// 4. Historical claims: every wallet with hasClaimed() on an earlier claim contract is excluded, and the
//    number of such wallets equals the historical claimed supply.
// 5. Used units stay with their claimants: each historical claimant still holds the token id it used, so no
//    other wallet can be eligible on a unit that already produced a free claim.
import { getAddress, id, keccak256, toUtf8Bytes } from "ethers";
import { buildWeekendTree, WEEKEND_CAMPAIGN } from "./genesis-weekend-merkle.js";

export const GENESIS_TOKEN_IDS = Object.freeze([0, 1, 2, 3]);
export const SOURCE_BRIDGE = "0x68539f95FB2758327A9C7EdEDa1002b0F3Ec8992";
export const GROTTO_WRAPPED = "0x0d6Fa9968aa57295217737379c44eBbc1130B1Fa";
export const ZERO = "0x0000000000000000000000000000000000000000";
export const DEFAULT_QUIET_SECONDS = 1800;
export const SNAPSHOT_FORMAT = "the-void:genesis-weekend-snapshot:v1";

const EXCLUDED = new Set([ZERO, SOURCE_BRIDGE, GROTTO_WRAPPED].map((address) => address.toLowerCase()));

const big = (value) => BigInt(value);
const sum = (values) => values.reduce((total, value) => total + big(value), 0n);
const balancesOf = (record) => GENESIS_TOKEN_IDS.map((tokenId) => big(record?.[tokenId] ?? 0));
const held = (record) => balancesOf(record).some((value) => value > 0n);

function normalizeBalances(map) {
  const out = new Map();
  for (const [wallet, record] of map instanceof Map ? map : Object.entries(map || {})) {
    const address = getAddress(wallet);
    if (out.has(address)) throw new Error(`Duplicate balance record for ${address}.`);
    out.set(address, balancesOf(record));
  }
  return out;
}

export function snapshotHashFor({ cchainBlock, cchainBlockHash, grottoBlock, grottoBlockHash, root, wallets }) {
  const canonical = JSON.stringify({
    format: SNAPSHOT_FORMAT,
    campaign: WEEKEND_CAMPAIGN,
    cchainBlock: String(cchainBlock),
    cchainBlockHash: String(cchainBlockHash).toLowerCase(),
    grottoBlock: String(grottoBlock),
    grottoBlockHash: String(grottoBlockHash).toLowerCase(),
    root: String(root).toLowerCase(),
    wallets: [...wallets].map((wallet) => getAddress(wallet).toLowerCase()).sort(),
  });
  return keccak256(toUtf8Bytes(canonical));
}

/**
 * @returns {{ ok: boolean, failures: string[], eligible: object[], excluded: object[], reconciliation: object,
 *   root?: string, snapshotHash?: string, eligibleWallets?: number }}
 */
export function computeWeekendSnapshot({
  cchain,
  grotto,
  priorClaimants,
  historicalClaimedSupply,
  historicalClaims,
  bridgeActivity,
  quietSeconds = DEFAULT_QUIET_SECONDS,
}) {
  const failures = [];
  const cBalances = normalizeBalances(cchain.balances);
  const gBalances = normalizeBalances(grotto.balances);
  const custody = cBalances.get(getAddress(SOURCE_BRIDGE)) ?? [0n, 0n, 0n, 0n];
  const reconciliation = { tokenIds: {} };

  // 1 and 2: per-id supply conservation on both chains.
  for (const tokenId of GENESIS_TOKEN_IDS) {
    const cTotal = sum([...cBalances.values()].map((values) => values[tokenId]));
    const cIssued = big(cchain.mintsMinusBurns[tokenId]);
    const gTotal = sum([...gBalances.values()].map((values) => values[tokenId]));
    const gIssued = big(grotto.mintsMinusBurns[tokenId]);
    reconciliation.tokenIds[tokenId] = {
      cchainBalanceSum: cTotal.toString(), cchainMintsMinusBurns: cIssued.toString(),
      bridgeCustody: custody[tokenId].toString(), grottoBalanceSum: gTotal.toString(), grottoMintsMinusBurns: gIssued.toString(),
    };
    if (cTotal !== cIssued) failures.push(`C-Chain token ${tokenId}: holder balances ${cTotal} != mints minus burns ${cIssued} (incomplete holder set).`);
    if (gTotal !== gIssued) failures.push(`Grotto token ${tokenId}: holder balances ${gTotal} != mints minus burns ${gIssued}.`);
    if (custody[tokenId] !== gTotal) failures.push(`Token ${tokenId}: bridge custody ${custody[tokenId]} != Grotto wrapped supply ${gTotal} (a bridge message is in flight).`);
  }

  // 3: the two snapshots describe the same moment and the bridge was quiet around it.
  reconciliation.grottoLagSeconds = Number(cchain.timestamp) - Number(grotto.timestamp);
  if (Number(grotto.timestamp) > Number(cchain.timestamp)) failures.push("The Grotto snapshot block is later than the C-Chain snapshot.");
  if (grotto.nextBlockTimestamp === undefined) failures.push("The Grotto next-block timestamp was not supplied.");
  else if (grotto.nextBlockTimestamp !== null && Number(grotto.nextBlockTimestamp) <= Number(cchain.timestamp)) {
    failures.push("A later Grotto block exists at or before the C-Chain snapshot time; the Grotto snapshot is stale.");
  }
  const from = Math.min(Number(cchain.timestamp), Number(grotto.timestamp)) - quietSeconds;
  const to = Math.max(Number(cchain.timestamp), Number(grotto.timestamp)) + quietSeconds;
  const noisy = (bridgeActivity || []).filter((event) => Number(event.timestamp) >= from && Number(event.timestamp) <= to);
  reconciliation.quietWindow = { from, to, events: noisy.length };
  for (const event of noisy) failures.push(`Bridge activity inside the quiet window: ${event.chain} ${event.kind} ${event.transactionHash} at ${event.timestamp}.`);
  if (bridgeActivity === undefined || bridgeActivity === null) failures.push("Bridge activity was not supplied.");

  // 4: historical claimants.
  const claimants = new Set([...(priorClaimants || [])].map((wallet) => getAddress(wallet)));
  reconciliation.priorClaimants = claimants.size;
  if (big(historicalClaimedSupply) !== BigInt(claims(historicalClaims).length) || claims(historicalClaims).length !== claimants.size) {
    failures.push(`Historical claims do not reconcile: claimed supply ${historicalClaimedSupply}, claim records ${claims(historicalClaims).length}, wallets with hasClaimed ${claimants.size}.`);
  }
  for (const record of claims(historicalClaims)) {
    if (!claimants.has(getAddress(record.wallet))) failures.push(`Historical claim ${record.transactionHash} by ${record.wallet} is not reported by hasClaimed().`);
  }

  // 5: used units stayed with their claimants.
  for (const record of claims(historicalClaims)) {
    const balance = (cBalances.get(getAddress(record.wallet)) ?? [0n, 0n, 0n, 0n])[Number(record.usedTokenId)];
    if (balance === undefined || balance < 1n) failures.push(`Claimant ${record.wallet} no longer holds token ${record.usedTokenId}, the unit its claim used.`);
  }

  // Eligibility: one entry per wallet across both chains.
  const wallets = new Set([...cBalances.keys(), ...gBalances.keys()]);
  const eligible = [];
  const excluded = [];
  for (const wallet of [...wallets].sort()) {
    const c = cBalances.get(wallet);
    const g = gBalances.get(wallet);
    const sources = [...(held(c) ? ["c-chain"] : []), ...(held(g) ? ["grotto"] : [])];
    if (!sources.length) continue;
    const entry = { wallet, sources, cchainBalances: (c ?? [0n, 0n, 0n, 0n]).map(String), grottoBalances: (g ?? [0n, 0n, 0n, 0n]).map(String) };
    if (EXCLUDED.has(wallet.toLowerCase())) excluded.push({ ...entry, reason: "BRIDGE_OR_SYSTEM_ADDRESS" });
    else if (claimants.has(wallet)) excluded.push({ ...entry, reason: "PRIOR_CLAIM" });
    else eligible.push(entry);
  }
  reconciliation.eligibleBySource = {
    cchainOnly: eligible.filter(({ sources }) => sources.length === 1 && sources[0] === "c-chain").length,
    grottoOnly: eligible.filter(({ sources }) => sources.length === 1 && sources[0] === "grotto").length,
    both: eligible.filter(({ sources }) => sources.length === 2).length,
  };
  if (!eligible.length) failures.push("No eligible wallets.");
  if (failures.length) return { ok: false, failures, eligible, excluded, reconciliation };

  const tree = buildWeekendTree(eligible.map(({ wallet }) => wallet));
  const snapshotHash = snapshotHashFor({
    cchainBlock: cchain.block, cchainBlockHash: cchain.blockHash, grottoBlock: grotto.block, grottoBlockHash: grotto.blockHash,
    root: tree.root, wallets: tree.wallets,
  });
  return { ok: true, failures, eligible, excluded, reconciliation, root: tree.root, snapshotHash, eligibleWallets: tree.size };
}

function claims(historicalClaims) {
  return Array.isArray(historicalClaims) ? historicalClaims : [];
}

export const WEEKEND_RULE_TEXT = "the-void:genesis-weekend:v1:snapshot(cchain-balanceOf(wallet,0..3)>0|grotto-wrapped-balanceOf(wallet,0..3)>0)"
  + ";excluding-bridge-custody,zero-address,prior-claimants;one-per-wallet";
export const WEEKEND_RULE = id(WEEKEND_RULE_TEXT);
