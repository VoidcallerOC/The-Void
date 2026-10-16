import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { CHAINS, checkOwnership, checkCollectionOwnership, checkOwnershipRecords, checkCollectionOwnershipRecords, choirIdentity } from "./web3.js";
import { VC_AUDIO } from "./audio.js";
import { WalletCtx } from "./wallet-context.js";
import { authenticateWallet, authorizationHeaders } from "./wallet-auth.js";
import {
  ensureReleaseChain,
  isOnReleaseChain,
  isReleaseChainGateError,
  releaseNetworkRequiredMessage,
} from "./release-chain.js";
import { connectWithReleaseChain, logWalletConnectDiag } from "./wallet-connect-flow.js";
import { RELEASE_DEPLOYMENT } from "../../config/release-network.js";

// Known wallet flags → rdns, so legacy injection dedups against EIP-6963.
const LEGACY_RDNS = {
  isMetaMask: "io.metamask",
  isRabby: "io.rabby",
  isCoinbaseWallet: "com.coinbase.wallet",
  isCore: "app.core",
  isAvalanche: "app.core",
};
const LEGACY_NAMES = {
  isMetaMask: "MetaMask",
  isRabby: "Rabby",
  isCoinbaseWallet: "Coinbase Wallet",
  isCore: "Core",
  isAvalanche: "Core",
};
const AUTH_CHAIN_ID = RELEASE_DEPLOYMENT.chainId;

function emptyOwnership(chains = CHAINS) {
  return Object.fromEntries(Object.keys(chains || CHAINS).map((key) => [key, new Set()]));
}

export function WalletProvider({ children, collectionConfig = null, ownershipReader = checkOwnership, ownershipRecordsReader = checkOwnershipRecords }) {
  const [wallets, setWallets] = useState([]); // detected providers
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [owned, setOwned] = useState(() => emptyOwnership(collectionConfig?.chains || CHAINS));
  const [ownershipRecords, setOwnershipRecords] = useState([]);
  const [loadingOwnership, setLoadingOwnership] = useState(false);
  const [provider, setProvider] = useState(null);
  const [authSession, setAuthSession] = useState(null);
  const [authenticationError, setAuthenticationError] = useState(null);
  const [authenticating, setAuthenticating] = useState(false);
  const providerRef = useRef(null);
  const collectionConfigRef = useRef(collectionConfig);
  const ownershipRequestRef = useRef(0);
  // Track the live listeners so we can detach them on disconnect / re-wire,
  // otherwise reconnecting stacks duplicate handlers and chainChanged keeps
  // firing after the user has disconnected.
  const listenersRef = useRef(null);
  const identity = useMemo(() => choirIdentity(owned), [owned]);

  useEffect(() => {
    collectionConfigRef.current = collectionConfig;
  }, [collectionConfig]);

  // --- wallet detection (EIP-6963 + legacy) ---
  useEffect(() => {
    const found = [];
    const push = (w) => {
      setWallets((prev) => {
        if (prev.find((p) => p.rdns && p.rdns === w.rdns)) return prev;
        if (prev.find((p) => p.name === w.name)) return prev;
        return [...prev, w];
      });
    };

    const onAnnounce = (event) => {
      const { info, provider } = event.detail;
      push({ name: info.name, icon: info.icon, rdns: info.rdns, provider, eip6963: true });
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    // legacy injection fallback after a tick
    const t = setTimeout(() => {
      if (!window.ethereum) return;
      const providers = Array.isArray(window.ethereum.providers)
        ? window.ethereum.providers
        : [window.ethereum];
      for (const provider of providers) {
        let matched = null;
        for (const [flag, rdns] of Object.entries(LEGACY_RDNS)) {
          if (provider[flag]) { matched = { name: LEGACY_NAMES[flag], rdns }; break; }
        }
        const info = matched || { name: "Browser Wallet", rdns: null };
        push({ ...info, provider, eip6963: false });
      }
    }, 200);

    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      clearTimeout(t);
      void found;
    };
  }, []);

  // Push owned token ids into the audio singleton so released-EP playback
  // unlocks full tracks for bearers (and re-locks on disconnect).
  useEffect(() => {
    const ids = [...(owned.cchain || []), ...(owned.grotto || [])];
    VC_AUDIO.setOwnership(ids);
  }, [owned]);

  const refreshOwnership = useCallback(async (addr) => {
    const requestId = ++ownershipRequestRef.current;
    const target = addr || account;
    if (!target) {
      setOwned(emptyOwnership(collectionConfig?.chains || CHAINS));
      setOwnershipRecords([]);
      setLoadingOwnership(false);
      return;
    }
    setLoadingOwnership(true);
    try {
      const result = await (collectionConfig ? checkCollectionOwnership(target, collectionConfig) : ownershipReader(target));
      const records = await (collectionConfig ? checkCollectionOwnershipRecords(target, collectionConfig) : ownershipRecordsReader(target));
      if (requestId === ownershipRequestRef.current) {
        setOwned(result);
        setOwnershipRecords(records);
      }
    } finally {
      if (requestId === ownershipRequestRef.current) setLoadingOwnership(false);
    }
  }, [account, collectionConfig, ownershipReader, ownershipRecordsReader]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() => cancelled ? undefined : refreshOwnership(account))
      .catch(() => {});
    return () => { cancelled = true; };
  }, [account, refreshOwnership]);

  const clearAuthentication = useCallback(() => {
    void VC_AUDIO.revokeMediaGrants();
    VC_AUDIO.setMediaAuthorization();
    setAuthSession(null);
    setAuthenticationError(null);
    setAuthenticating(false);
  }, []);

  const authenticate = useCallback(async ({ targetProvider = providerRef.current, wallet = account } = {}) => {
    if (!targetProvider || !wallet) {
      const error = releaseNetworkRequiredMessage(RELEASE_DEPLOYMENT, { action: "connect and sign in" });
      setAuthenticationError(error);
      return { error, code: "AUTH_WALLET_REQUIRED" };
    }
    setAuthenticating(true);
    setAuthenticationError(null);
    try {
      // Re-request / verify the release chain before any auth signature so a
      // wallet left on Ethereum (or Fuji during a mainnet build) cannot sign.
      const verifiedChainId = await ensureReleaseChain(targetProvider);
      setChainId(verifiedChainId);
      if (!isOnReleaseChain(verifiedChainId)) {
        const error = releaseNetworkRequiredMessage(RELEASE_DEPLOYMENT, { action: "sign in" });
        setAuthenticationError(error);
        return { error, code: "AUTH_CHAIN_UNSUPPORTED" };
      }
      const session = await authenticateWallet({ provider: targetProvider, wallet, chainId: verifiedChainId });
      setAuthSession(session);
      VC_AUDIO.setMediaAuthorization({ wallet, authHeaders: authorizationHeaders(session) });
      return { ok: true, session };
    } catch (error) {
      setAuthSession(null);
      try {
        const cid = await targetProvider.request({ method: "eth_chainId" });
        setChainId(Number(BigInt(cid)));
      } catch { /* ignore */ }
      const message = isReleaseChainGateError(error)
        ? (error.message || releaseNetworkRequiredMessage(RELEASE_DEPLOYMENT, { action: "sign in" }))
        : (error?.message || "Wallet authentication failed.");
      setAuthenticationError(message);
      return { error: message, code: error?.code || "AUTH_REQUEST_FAILED" };
    } finally {
      setAuthenticating(false);
    }
  }, [account]);

  /** Prompt wallet_switchEthereumChain to the release network; never auth/tx until verified. */
  const ensureNetwork = useCallback(async ({ targetProvider = providerRef.current, thenAuthenticate = true } = {}) => {
    const p = targetProvider || providerRef.current || window.ethereum;
    if (!p) {
      const error = "No wallet detected. Install MetaMask, Rabby, or Core.";
      setAuthenticationError(error);
      return { error, code: "WALLET_PROVIDER_REQUIRED" };
    }
    try {
      const verifiedChainId = await ensureReleaseChain(p);
      setChainId(verifiedChainId);
      setAuthenticationError(null);
      logWalletConnectDiag("ensure_network_ok", { chainId: verifiedChainId });
      if (thenAuthenticate && account) {
        return authenticate({ targetProvider: p, wallet: account });
      }
      return { ok: true, chainId: verifiedChainId };
    } catch (error) {
      try {
        const cid = await p.request({ method: "eth_chainId" });
        setChainId(Number(BigInt(cid)));
      } catch { /* ignore */ }
      logWalletConnectDiag("ensure_network_failed", { code: error?.code || null });
      const message = error?.message || releaseNetworkRequiredMessage(RELEASE_DEPLOYMENT);
      setAuthenticationError(message);
      return { error: message, code: error?.code || "CHAIN_SWITCH_FAILED" };
    }
  }, [account, authenticate]);

  // Detach whatever listeners we last attached (if any) from their provider.
  const unwireProvider = useCallback(() => {
    const live = listenersRef.current;
    if (live) {
      live.provider.removeListener?.("accountsChanged", live.onAccountsChanged);
      live.provider.removeListener?.("chainChanged", live.onChainChanged);
      listenersRef.current = null;
    }
  }, []);

  const wireProvider = useCallback((provider) => {
    // Drop any previously-wired listeners before attaching new ones so a
    // second connect doesn't double up handlers.
    unwireProvider();
    providerRef.current = provider;
    setProvider(provider);

    const onAccountsChanged = (accts) => {
      if (!accts || accts.length === 0) {
        clearAuthentication();
        setAccount(null);
        setOwned(emptyOwnership(collectionConfigRef.current?.chains || CHAINS));
        setOwnershipRecords([]);
      } else {
        clearAuthentication();
        setAccount(accts[0]);
      }
    };
    const onChainChanged = (cid) => {
      clearAuthentication();
      setChainId(parseInt(cid, 16));
    };

    provider.on?.("accountsChanged", onAccountsChanged);
    provider.on?.("chainChanged", onChainChanged);
    listenersRef.current = { provider, onAccountsChanged, onChainChanged };
  }, [clearAuthentication, unwireProvider]);

  const connect = useCallback(async (provider) => {
    const p = provider || providerRef.current || window.ethereum;
    if (!p) return { error: "No wallet detected. Install MetaMask, Rabby, or Core." };
    try {
      // See wallet-connect-flow.js: Rabby opens Connect (ETH default) for
      // wallet_switchEthereumChain when the origin is not yet permitted.
      // Fresh connect → accounts first, then ensure. Reconnect → ensure first.
      // Dapps cannot force Rabby's Connect selector off Ethereum — after
      // permission we immediately request Avalanche and refuse auth otherwise.
      const { accounts, chainId: selectedChainId } = await connectWithReleaseChain(p);
      setAccount(accounts[0]);
      setChainId(selectedChainId);
      wireProvider(p);
      if (!isOnReleaseChain(selectedChainId)) {
        const message = releaseNetworkRequiredMessage(RELEASE_DEPLOYMENT, { action: "sign in" });
        setAuthenticationError(message);
        return { error: message, code: "WRONG_CHAIN" };
      }
      return authenticate({ targetProvider: p, wallet: accounts[0] });
    } catch (error) {
      let reportedChainId = null;
      try {
        const cid = await p.request({ method: "eth_chainId" });
        reportedChainId = Number(BigInt(cid));
        setChainId(reportedChainId);
      } catch { /* ignore */ }
      logWalletConnectDiag("connect_failed", { code: error?.code || null, currentChainId: reportedChainId });

      // Permission may already be granted (accounts returned) while switch was
      // rejected or stuck on Ethereum — keep the session connected so the UI
      // can show SWITCH NETWORK instead of silently disconnecting.
      if (isReleaseChainGateError(error)) {
        try {
          const accts = await p.request({ method: "eth_accounts" });
          if (accts?.length) {
            setAccount(accts[0]);
            wireProvider(p);
          }
        } catch { /* ignore */ }
      }

      const code = error?.code || "WALLET_CONNECTION_FAILED";
      const message = code === 4001
        ? "Wallet connection was rejected."
        : (error?.message || releaseNetworkRequiredMessage(RELEASE_DEPLOYMENT));
      setAuthenticationError(message);
      return { error: message, code };
    }
  }, [wireProvider, authenticate]);

  const disconnect = useCallback(() => {
    unwireProvider();
    clearAuthentication();
    setAccount(null);
    setChainId(null);
    setOwned(emptyOwnership(collectionConfig?.chains || CHAINS));
    setOwnershipRecords([]);
    providerRef.current = null;
    setProvider(null);
  }, [clearAuthentication, collectionConfig, unwireProvider]);

  // restore an already-authorized session on load
  useEffect(() => {
    if (!window.ethereum) return;
    (async () => {
      try {
        const accts = await window.ethereum.request({ method: "eth_accounts" });
        if (accts && accts.length) {
          const cid = await window.ethereum.request({ method: "eth_chainId" });
          setAccount(accts[0]);
          setChainId(parseInt(cid, 16));
          wireProvider(window.ethereum);
        }
      } catch {
        // not connected — expected
      }
    })();
  }, [wireProvider]);

  // Detach provider listeners if the provider tree unmounts.
  useEffect(() => unwireProvider, [unwireProvider]);

  const onReleaseChain = isOnReleaseChain(chainId);
  const needsNetworkSwitch = !!account && chainId != null && !onReleaseChain;

  const value = {
    wallets,
    account,
    chainId,
    owned,
    ownershipRecords,
    identity,
    loadingOwnership,
    connected: !!account,
    authenticated: !!authSession && onReleaseChain,
    authenticating,
    authenticationError,
    authSession: onReleaseChain ? authSession : null,
    authHeaders: authorizationHeaders(onReleaseChain ? authSession : null),
    provider,
    releaseChainId: AUTH_CHAIN_ID,
    releaseNetworkName: RELEASE_DEPLOYMENT.networkName,
    onReleaseChain,
    needsNetworkSwitch,
    getProvider: () => providerRef.current || window.ethereum,
    connect,
    ensureNetwork,
    authenticate,
    disconnect,
    refreshOwnership,
  };

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}
