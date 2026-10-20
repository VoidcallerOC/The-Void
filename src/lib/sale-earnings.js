import { ethers } from "ethers";
import { FUJI_RELEASE_FACTORY_V2_CONFIG, fujiExplorerUrl, requestWithTimeout } from "./fuji-release.js";
import { SIMULATION_GAS } from "./primary-sale.js";
import { ACTIVE_RELEASE_PER_CONTRACT_DEPLOYMENTS, RELEASE_PER_CONTRACT, releaseDeploymentForFactory } from "../../config/release-network.js";
import { waitForReceipt } from "./web3.js";
import { verifyAuthorizedSale } from "./sale-authorization.js";

// VoidPrimarySale holds proceeds as pull payments: purchase() credits
// balances[payoutOf(tokenId)] and balances[platformRecipient], and withdraw()
// pays msg.sender's whole balance. One balance per (sale contract, address).
export const SALE_EARNINGS_ABI = Object.freeze([
  "function balances(address) view returns (uint256)",
  "function platformRecipient() view returns (address)",
  "function releases() view returns (address)",
  "function withdraw()",
  "event Withdrawn(address indexed account, uint256 amount)",
  "error NothingToWithdraw()",
  "error TransferFailed()",
  "error Reentrancy()",
]);
const saleIface = new ethers.Interface(SALE_EARNINGS_ABI);
const releaseIface = new ethers.Interface(["function payoutOf(uint256 tokenId) view returns (address)"]);
// Mint revenue is primary-sale revenue: the release's mint() is not payable, so AVAX only ever
// reaches a sale contract. One category, "Primary sales (paid at mint)".
const factoryIface = new ethers.Interface([
  "function releasesOf(address artist) view returns (address[])",
  "function primarySaleOf(address release) view returns (address)",
]);
export const WITHDRAW_CALLDATA = saleIface.encodeFunctionData("withdraw", []);
const WITHDRAWN_TOPIC = saleIface.getEvent("Withdrawn").topicHash;

/** "0.24375 AVAX", "0 AVAX": native AVAX, no trailing ".0". */
export function formatEarnings(wei) {
  const text = ethers.formatEther(BigInt(wei));
  return `${text.endsWith(".0") ? text.slice(0, -2) : text} AVAX`;
}

function checksum(value) {
  const text = String(value || "").trim();
  if (!ethers.isAddress(text) || ethers.getAddress(text) === ethers.ZeroAddress) return "";
  return ethers.getAddress(text);
}

/** A non-negative integer string, or null when the API did not report it (never an invented 0). */
function weiText(value) {
  const text = String(value ?? "").trim();
  return /^\d+$/.test(text) ? text : null;
}

const same = (a, b) => Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();

export function factoryLabel(factoryAddress) {
  const deployment = releaseDeploymentForFactory(factoryAddress);
  if (deployment) return deployment.active ? "Factory V2 (active)" : "Factory V2 (historical)";
  return factoryAddress ? `Factory ${factoryAddress.slice(0, 6)}…${factoryAddress.slice(-4)}` : "Factory unknown";
}

/** Normalizes GET /studio/catalog releaseBindings rows (snake_case from SQL). */
export function mapReleaseBindings(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    releaseId: String(row?.release_id ?? row?.releaseId ?? ""),
    chainId: Number(row?.chain_id ?? row?.chainId ?? 0),
    releaseContractAddress: checksum(row?.release_contract_address ?? row?.releaseContractAddress),
    primarySaleAddress: checksum(row?.primary_sale_address ?? row?.primarySaleAddress),
    factoryAddress: checksum(row?.factory_address ?? row?.factoryAddress),
    artistWallet: checksum(row?.artist_wallet ?? row?.artistWallet),
    artistEarnedWei: weiText(row?.artist_earned_wei ?? row?.artistEarnedWei),
    artistWithdrawnWei: weiText(row?.artist_withdrawn_wei ?? row?.artistWithdrawnWei),
  })).filter((binding) => binding.releaseId && binding.primarySaleAddress && binding.releaseContractAddress);
}

/**
 * Normalizes catalog `releaseSales`: one row per (release contract, sale contract) that has
 * indexed primary purchases, artist-only fields. A satellite settled sale shows up here even
 * though the factory never registered it.
 */
export function mapReleaseSales(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    chainId: Number(row?.chain_id ?? row?.chainId ?? 0),
    releaseContractAddress: checksum(row?.release_contract_address ?? row?.releaseContractAddress),
    primarySaleAddress: checksum(row?.sale_contract_address ?? row?.primarySaleAddress ?? row?.saleContractAddress),
    artistEarnedWei: weiText(row?.artist_earned_wei ?? row?.artistEarnedWei),
    artistWithdrawnWei: weiText(row?.artist_withdrawn_wei ?? row?.artistWithdrawnWei),
    sales: Number(row?.sales ?? 0) || 0,
  })).filter((row) => row.chainId && row.primarySaleAddress && row.releaseContractAddress);
}

/** Normalizes catalog `secondaryRoyalties` (indexed marketplace royalty totals per token). */
export function mapSecondaryRoyalties(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    chainId: Number(row?.chain_id ?? row?.chainId ?? 0),
    tokenContractAddress: checksum(row?.token_contract_address ?? row?.tokenContractAddress),
    tokenId: /^\d+$/.test(String(row?.token_id ?? row?.tokenId ?? "").trim()) ? String(row?.token_id ?? row?.tokenId).trim() : "",
    royaltyWei: weiText(row?.royalty_wei ?? row?.royaltyWei) ?? "0",
    sales: Number(row?.sales ?? 0) || 0,
  })).filter((row) => row.chainId && row.tokenContractAddress && row.tokenId);
}

/**
 * One entry per sale contract the artist's releases are bound to, across every
 * factory version, with the published token ids whose payouts it credits.
 * Release bindings are the source; edition rows add token ids (and a sale for
 * an edition whose binding row is missing).
 */
export function earningsTargets(catalog = {}, { chainId = FUJI_RELEASE_FACTORY_V2_CONFIG.chainId } = {}) {
  const titles = new Map((catalog.releases || []).map((release) => [release.id, release.title || release.id]));
  const targets = new Map();
  const add = ({ releaseId, primarySaleAddress, releaseContractAddress, factoryAddress, artistWallet, artistEarnedWei = null, artistWithdrawnWei = null }) => {
    const sale = checksum(primarySaleAddress);
    const release = checksum(releaseContractAddress);
    if (!sale || !release) return null;
    const key = sale.toLowerCase();
    const existing = targets.get(key);
    if (existing) {
      existing.factoryAddress ||= checksum(factoryAddress);
      existing.artistWallet ||= checksum(artistWallet);
      existing.artistEarnedWei ??= weiText(artistEarnedWei);
      existing.artistWithdrawnWei ??= weiText(artistWithdrawnWei);
      return existing;
    }
    const edition = (catalog.editions || []).find((item) => same(item.releaseContractAddress || item.contractAddress, release));
    const knownReleaseId = releaseId || edition?.releaseId || "";
    const entry = { releaseId: knownReleaseId, title: titles.get(knownReleaseId) || knownReleaseId || `Release ${release.slice(0, 6)}…${release.slice(-4)}`, chainId: Number(chainId), primarySaleAddress: sale, releaseContractAddress: release, factoryAddress: checksum(factoryAddress), artistWallet: checksum(artistWallet), artistEarnedWei: weiText(artistEarnedWei), artistWithdrawnWei: weiText(artistWithdrawnWei), tokenIds: [] };
    targets.set(key, entry);
    return entry;
  };
  // Per-sale rows first, so their indexed earned/withdrawn figures win and a settled sale the
  // factory never registered still gets its own card. Two sales of one release stay separate.
  for (const row of catalog.releaseSales || []) {
    if (Number(row.chainId) !== Number(chainId)) continue;
    add(row);
  }
  for (const binding of catalog.releaseBindings || []) {
    if (Number(binding.chainId) !== Number(chainId)) continue;
    add(binding);
  }
  for (const target of targets.values()) {
    target.factoryAddress ||= [...targets.values()].find((item) => same(item.releaseContractAddress, target.releaseContractAddress) && item.factoryAddress)?.factoryAddress || "";
  }
  for (const edition of catalog.editions || []) {
    if (Number(edition.chainId) !== Number(chainId) || !edition.tokenIds?.length) continue;
    const releaseContract = edition.releaseContractAddress || edition.contractAddress;
    // payoutOf is a release-level read, so every sale of the release gets the token ids.
    let matches = [...targets.values()].filter((item) => same(item.releaseContractAddress, releaseContract));
    if (!matches.length) {
      const created = add({ releaseId: edition.releaseId, primarySaleAddress: edition.primarySaleAddress, releaseContractAddress: releaseContract, factoryAddress: edition.factoryAddress });
      matches = created ? [created] : [];
    }
    for (const target of matches) for (const tokenId of edition.tokenIds) if (!target.tokenIds.includes(String(tokenId))) target.tokenIds.push(String(tokenId));
  }
  return [...targets.values()].map((target) => ({ ...target, factoryLabel: factoryLabel(target.factoryAddress) }));
}

/**
 * Release bindings read straight from every V2 factory: releasesOf(wallet) and
 * primarySaleOf(release). Covers releases the API has not reported (or an API
 * that predates releaseBindings). A factory that cannot be read is skipped.
 */
export async function discoverFactoryBindings(provider, account, deployments = ACTIVE_RELEASE_PER_CONTRACT_DEPLOYMENTS) {
  const wallet = checksum(account);
  if (!wallet) return [];
  const bindings = [];
  for (const deployment of deployments) {
    const factory = checksum(deployment.factoryAddress);
    if (!factory) continue;
    try {
      const releases = await call(provider, factory, factoryIface, "releasesOf", [wallet]);
      for (const releaseAddress of releases) {
        const releaseContractAddress = checksum(releaseAddress);
        const primarySaleAddress = checksum(await call(provider, factory, factoryIface, "primarySaleOf", [releaseContractAddress]));
        if (releaseContractAddress && primarySaleAddress) bindings.push({ releaseId: "", chainId: Number(deployment.chainId), releaseContractAddress, primarySaleAddress, factoryAddress: factory, artistWallet: wallet });
      }
    } catch { /* this factory could not be read; API bindings still apply */ }
  }
  return bindings;
}

async function call(provider, to, iface, name, args) {
  const result = await provider.request({ method: "eth_call", params: [{ to, data: iface.encodeFunctionData(name, args) }, "latest"] });
  return iface.decodeFunctionResult(name, result)[0];
}

export async function readSaleBalance(provider, saleAddress, account) {
  return BigInt(await call(provider, checksum(saleAddress), saleIface, "balances", [checksum(account)]));
}

/**
 * Reads one sale's balances live. Payout addresses come from the edition's
 * payoutOf(tokenId); the connected wallet is also read so a balance left under
 * it by an earlier payout is never hidden.
 */
export async function readSaleEarnings(provider, target, account = "", options = {}) {
  const payouts = [];
  const errors = [];
  const verification = await verifySaleBinding(provider, target, options);
  for (const tokenId of target.tokenIds || []) {
    try {
      const payout = checksum(await call(provider, target.releaseContractAddress, releaseIface, "payoutOf", [BigInt(tokenId)]));
      if (payout && !payouts.some((item) => same(item, payout))) payouts.push(payout);
    } catch (error) {
      errors.push(`payoutOf(${tokenId}) failed: ${error?.message || "read failed"}`);
    }
  }
  const wallet = checksum(account);
  const candidates = [...payouts];
  for (const extra of [wallet, target.artistWallet]) if (extra && !candidates.some((item) => same(item, extra))) candidates.push(extra);
  const rows = [];
  for (const address of candidates) {
    const isPayout = payouts.some((item) => same(item, address));
    // The platform fee recipient is never an artist payee: its credit (legacy sale) or transfer
    // (settled sale) is the platform's, and is never listed, totalled or withdrawable here.
    if (!isPayout && same(address, verification.platformRecipient)) continue;
    const balanceWei = await readSaleBalance(provider, target.primarySaleAddress, address);
    // Non-payout addresses only appear when something is actually held for them.
    if (!isPayout && balanceWei === 0n && (payouts.length || !same(address, wallet))) continue;
    rows.push({ address, balanceWei, isPayout, canWithdraw: same(address, wallet) && verification.verified });
  }
  // Earned to date is the indexer's sum of artist cuts for this sale. Withdrawn is the indexer's
  // sum of the artist wallet's Withdrawn events when reported; otherwise it is derived (earned -
  // still held) and flagged as derived, and only when exactly one payout holds the balance.
  const earnedWei = target.artistEarnedWei == null ? null : BigInt(target.artistEarnedWei);
  const withdrawnIndexedWei = target.artistWithdrawnWei == null ? null : BigInt(target.artistWithdrawnWei);
  const payoutRows = rows.filter((row) => row.isPayout);
  let derivedWithdrawnWei = null;
  if (withdrawnIndexedWei === null && earnedWei !== null && payoutRows.length === 1) {
    const held = payoutRows[0].balanceWei;
    derivedWithdrawnWei = earnedWei > held ? earnedWei - held : 0n;
  }
  return { ...target, payouts: rows, errors, verification, earnedWei, withdrawnIndexedWei, derivedWithdrawnWei, kind: verification.kind };
}

/**
 * Live authorization of the sale a row points at: either the legacy sale the factory registered
 * for the release, or the reviewed settled sale the release has authorized as an issuer. A stale
 * config or database row can never route a withdrawal to any other contract.
 */
export async function verifySaleBinding(provider, target, { expectedPlatformRecipient = RELEASE_PER_CONTRACT.platformRecipient } = {}) {
  const result = await verifyAuthorizedSale(provider, {
    sale: target.primarySaleAddress,
    release: target.releaseContractAddress,
    factory: target.factoryAddress,
    expectedPlatformRecipient,
    chainId: target.chainId,
  });
  return { verified: result.authorized, problems: result.problems, platformRecipient: result.details.platformRecipient, kind: result.kind, details: result.details };
}

/**
 * Secondary-sale royalties for the connected wallet. The marketplace pays each royalty straight
 * to the edition's payout when the resale settles, so there is nothing to claim. Rows are kept
 * only where the LIVE payoutOf(tokenId) on the token's release equals the connected wallet.
 */
export async function readSecondaryRoyalties(provider, royalties, account = "", { chainId = FUJI_RELEASE_FACTORY_V2_CONFIG.chainId } = {}) {
  const wallet = checksum(account);
  const rows = [];
  let skipped = 0;
  if (wallet) {
    for (const royalty of royalties || []) {
      if (Number(royalty.chainId) !== Number(chainId)) continue;
      try {
        const payout = checksum(await call(provider, royalty.tokenContractAddress, releaseIface, "payoutOf", [BigInt(royalty.tokenId)]));
        if (same(payout, wallet)) rows.push({ ...royalty, payout });
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
  }
  const totalWei = rows.reduce((sum, row) => sum + BigInt(row.royaltyWei), 0n);
  return { rows, totalWei, skipped };
}

export async function readStudioEarnings(provider, targets, account = "", options = {}) {
  const results = [];
  for (const target of targets) {
    try {
      results.push(await readSaleEarnings(provider, target, account, options));
    } catch (error) {
      const verification = await verifySaleBinding(provider, target, options).catch(() => ({ verified: false, problems: ["The sale could not be verified."], platformRecipient: "", kind: null }));
      results.push({ ...target, payouts: [], errors: [error?.message || "Balance read failed."], verification, earnedWei: null, withdrawnIndexedWei: null, derivedWithdrawnWei: null, kind: null });
    }
  }
  return results;
}

export function earningsTotals(results, account = "") {
  let totalWei = 0n;
  let withdrawableWei = 0n;
  for (const result of results) {
    for (const row of result.payouts || []) {
      totalWei += row.balanceWei;
      if (same(row.address, account)) withdrawableWei += row.balanceWei;
    }
  }
  return { totalWei, withdrawableWei };
}

function revertData(error) {
  for (const candidate of [error?.data, error?.error?.data, error?.info?.error?.data, error?.cause?.data, error?.data?.data]) {
    if (typeof candidate === "string" && /^0x[0-9a-fA-F]{8,}$/.test(candidate)) return candidate;
  }
  return null;
}

export function explainWithdrawError(error) {
  const code = error?.code ?? error?.info?.error?.code ?? error?.cause?.code;
  const message = String(error?.shortMessage || error?.message || error || "");
  if (code === 4001 || code === "ACTION_REJECTED" || /user rejected|user denied|rejected the request/i.test(message)) return "Withdrawal rejected in the wallet. Nothing was sent.";
  if (code === "CHAIN_MISMATCH") return message;
  const data = revertData(error) || revertData(error?.cause);
  if (data) {
    try {
      const parsed = saleIface.parseError(data);
      if (parsed?.name === "NothingToWithdraw") return "This wallet has nothing to withdraw from this sale.";
      if (parsed?.name === "TransferFailed") return "The sale could not send AVAX to this wallet (the receiving address rejected it). Nothing was withdrawn.";
    } catch { /* unknown revert data */ }
  }
  if (/nothing to withdraw/i.test(message)) return "This wallet has nothing to withdraw from this sale.";
  return message || "Withdrawal failed.";
}

/** Reads the wallet's chain without prompting. */
export async function walletChainState(walletProvider, chainId) {
  if (!walletProvider?.request) return { ok: false, current: null, expected: Number(chainId), unavailable: true };
  const current = Number(BigInt(await walletProvider.request({ method: "eth_chainId" })));
  return { ok: current === Number(chainId), current, expected: Number(chainId) };
}

/** Asks the wallet to switch to (adding, if unknown) the expected chain. */
export async function switchWalletChain(walletProvider, { chainId, networkName, rpcUrl, explorer }) {
  const hex = ethers.toQuantity(Number(chainId));
  try {
    await walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (error) {
    if (error?.code === 4001) throw error;
    if (error?.code === 4902 && rpcUrl) {
      await walletProvider.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: networkName, nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 }, rpcUrls: [rpcUrl], blockExplorerUrls: explorer ? [explorer] : [] }] });
    }
  }
  return walletChainState(walletProvider, chainId);
}

async function ensureWalletChain(provider, chainId) {
  if ((await walletChainState(provider, chainId)).ok) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ethers.toQuantity(Number(chainId)) }] });
  } catch (error) {
    if (error?.code === 4001) throw error;
  }
  if (!(await walletChainState(provider, chainId)).ok) throw Object.assign(new Error(`Switch your wallet to chain ${chainId} before withdrawing.`), { code: "CHAIN_MISMATCH" });
}

/** The amount a successful receipt proves was withdrawn: Withdrawn(account, amount) emitted by the sale. */
export function withdrawnFromReceipt(receipt, { saleAddress, account }) {
  for (const log of receipt?.logs || []) {
    if (!same(log?.address, saleAddress) || String(log?.topics?.[0] || "").toLowerCase() !== WITHDRAWN_TOPIC.toLowerCase()) continue;
    const parsed = saleIface.parseLog({ topics: log.topics, data: log.data });
    if (same(parsed.args.account, account)) return BigInt(parsed.args.amount);
  }
  return null;
}

/**
 * Simulates withdraw() from the payout wallet on the read provider, then asks
 * the wallet for exactly one withdraw() transaction to that sale contract.
 * `onSubmitted(hash)` fires as soon as the wallet returns a hash, before confirmation.
 * Success requires a successful receipt that carries this sale's Withdrawn event for the wallet.
 */
export async function withdrawSaleProceeds({ walletProvider, readProvider, from, saleAddress, chainId = FUJI_RELEASE_FACTORY_V2_CONFIG.chainId, onSubmitted }) {
  const sale = checksum(saleAddress);
  const wallet = checksum(from);
  if (!sale) throw new Error("The sale contract address is invalid.");
  if (!wallet) throw new Error("A connected wallet is required.");
  if (!walletProvider?.request) throw new Error("The wallet provider is unavailable. Reconnect your wallet.");
  await ensureWalletChain(walletProvider, chainId);
  try {
    await readProvider.request({ method: "eth_call", params: [{ from: wallet, to: sale, data: WITHDRAW_CALLDATA, gas: SIMULATION_GAS }, "latest"] });
  } catch (error) {
    throw Object.assign(new Error(explainWithdrawError(error)), { code: "WITHDRAW_SIMULATION_REVERTED", cause: error });
  }
  const hash = await requestWithTimeout(walletProvider, { method: "eth_sendTransaction", params: [{ from: wallet, to: sale, data: WITHDRAW_CALLDATA }] });
  const explorerUrl = fujiExplorerUrl("tx", hash);
  onSubmitted?.({ hash, explorerUrl });
  const receipt = await waitForReceipt(readProvider, hash);
  if (!receipt || receipt.status !== "0x1") throw Object.assign(new Error("The withdrawal did not receive a successful receipt."), { code: "TX_REVERTED", transactionHash: hash, explorerUrl });
  const receivedWei = withdrawnFromReceipt(receipt, { saleAddress: sale, account: wallet });
  if (receivedWei === null) throw Object.assign(new Error("The transaction succeeded but its receipt has no Withdrawn event from this sale for your wallet. Check the transaction before assuming payment."), { code: "WITHDRAW_EVENT_MISSING", transactionHash: hash, explorerUrl });
  return { hash, explorerUrl, receipt, receivedWei };
}
