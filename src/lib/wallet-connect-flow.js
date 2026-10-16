import { ensureReleaseChain, readWalletChainId } from "./release-chain.js";
import { RELEASE_DEPLOYMENT } from "../../config/release-network.js";

/**
 * Rabby (and similar permission-gated wallets): wallet_switchEthereumChain is an
 * "unsafe" method. When the origin has no permission yet, Rabby's rpcFlow shows
 * the Connect approval FIRST — and ConnectContent defaults the network selector
 * to Ethereum (recommendChains / CHAINS_ENUM.ETH). updateConnectSite is also a
 * no-op until a site record exists, so pre-connect switch cannot stick.
 *
 * Therefore: only ensure/switch BEFORE eth_requestAccounts when accounts are
 * already authorized. For a fresh connect, request accounts first, then ensure.
 */
export function shouldEnsureChainBeforeAccounts(existingAccounts) {
  return Array.isArray(existingAccounts) && existingAccounts.length > 0;
}

/** Non-secret connect diagnostics for production triage (no addresses/signatures). */
export function logWalletConnectDiag(event, detail = {}) {
  try {
    const payload = {
      event,
      releaseNetwork: RELEASE_DEPLOYMENT.network,
      targetChainId: Number(RELEASE_DEPLOYMENT.chainId),
      ...detail,
    };
    console.info("[void-wallet-connect]", payload);
  } catch { /* never break connect on logging */ }
}

export async function readExistingAccounts(provider) {
  if (!provider?.request) return [];
  try {
    const accounts = await provider.request({ method: "eth_accounts" });
    return Array.isArray(accounts) ? accounts : [];
  } catch (error) {
    logWalletConnectDiag("eth_accounts_failed", { code: error?.code || null });
    return [];
  }
}

/**
 * Full connect sequence used by WalletContext.
 * Returns { accounts, chainId } or throws coded errors.
 */
export async function connectWithReleaseChain(provider, {
  ensureChain = ensureReleaseChain,
  requestAccounts = (p) => p.request({ method: "eth_requestAccounts" }),
  readAccounts = readExistingAccounts,
  readChainId = readWalletChainId,
  log = logWalletConnectDiag,
} = {}) {
  if (!provider?.request) {
    throw Object.assign(new Error("No wallet detected. Install MetaMask or Core."), { code: "WALLET_PROVIDER_REQUIRED" });
  }

  const existing = await readAccounts(provider);
  const preAuthorize = shouldEnsureChainBeforeAccounts(existing);
  log("connect_start", { preAuthorize, existingAccountCount: existing.length });

  if (preAuthorize) {
    // Site already permitted — switch can update Rabby's site.chain before re-prompting.
    const chainId = await ensureChain(provider);
    log("pre_accounts_ensure_ok", { chainId });
  } else {
    log("pre_accounts_ensure_skipped", {
      reason: "no_permission_yet",
      note: "Rabby opens Connect on wallet_switchEthereumChain when unauthorized; selector defaults to Ethereum until a site exists.",
    });
  }

  const accounts = await requestAccounts(provider);
  if (!accounts?.length) {
    throw Object.assign(new Error("No accounts returned."), { code: "WALLET_NO_ACCOUNTS" });
  }
  log("accounts_ready", { accountCount: accounts.length });

  // Always verify/switch after accounts. This is the only reliable point for
  // first-time Rabby connects, and blocks auth on the wrong chain.
  let chainId;
  try {
    chainId = await ensureChain(provider);
    log("post_accounts_ensure_ok", { chainId });
  } catch (error) {
    let currentChainId = null;
    try { currentChainId = await readChainId(provider); } catch { /* ignore */ }
    log("post_accounts_ensure_failed", { code: error?.code || null, currentChainId });
    throw error;
  }

  return { accounts, chainId };
}
