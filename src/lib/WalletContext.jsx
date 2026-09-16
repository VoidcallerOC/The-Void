import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { checkOwnership, checkCollectionOwnership, checkOwnershipRecords, checkCollectionOwnershipRecords, choirIdentity } from "./web3.js";
import { VC_AUDIO } from "./audio.js";
import { WalletCtx } from "./wallet-context.js";
import { authenticateWallet, authorizationHeaders } from "./wallet-auth.js";

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

export function WalletProvider({ children, collectionConfig = null, ownershipReader = checkOwnership, ownershipRecordsReader = checkOwnershipRecords }) {
  const [wallets, setWallets] = useState([]); // detected providers
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [owned, setOwned] = useState({ cchain: new Set(), grotto: new Set() });
  const [ownershipRecords, setOwnershipRecords] = useState([]);
  const [loadingOwnership, setLoadingOwnership] = useState(false);
  const [provider, setProvider] = useState(null);
  const [authSession, setAuthSession] = useState(null);
  const [authenticationError, setAuthenticationError] = useState(null);
  const [authenticating, setAuthenticating] = useState(false);
  const providerRef = useRef(null);
  // Track the live listeners so we can detach them on disconnect / re-wire,
  // otherwise reconnecting stacks duplicate handlers and chainChanged keeps
  // firing after the user has disconnected.
  const listenersRef = useRef(null);
  const identity = useMemo(() => choirIdentity(owned), [owned]);

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
    const target = addr || account;
    if (!target) { setOwned({ cchain: new Set(), grotto: new Set() }); setOwnershipRecords([]); return; }
    setLoadingOwnership(true);
    try {
      const result = await (collectionConfig ? checkCollectionOwnership(target, collectionConfig) : ownershipReader(target));
      const records = await (collectionConfig ? checkCollectionOwnershipRecords(target, collectionConfig) : ownershipRecordsReader(target));
      setOwned(result);
      setOwnershipRecords(records);
    } finally {
      setLoadingOwnership(false);
    }
  }, [account, collectionConfig, ownershipReader, ownershipRecordsReader]);

  const clearAuthentication = useCallback(() => {
    void VC_AUDIO.revokeMediaGrants();
    VC_AUDIO.setMediaAuthorization();
    setAuthSession(null);
    setAuthenticationError(null);
    setAuthenticating(false);
  }, []);

  const authenticate = useCallback(async ({ targetProvider = providerRef.current, wallet = account, selectedChainId = chainId } = {}) => {
    if (!targetProvider || !wallet || !Number.isInteger(selectedChainId)) return { error: "Connect a wallet and select an Avalanche network first." };
    setAuthenticating(true);
    setAuthenticationError(null);
    try {
      const session = await authenticateWallet({ provider: targetProvider, wallet, chainId: selectedChainId });
      setAuthSession(session);
      VC_AUDIO.setMediaAuthorization({ wallet, authHeaders: authorizationHeaders(session) });
      return { ok: true, session };
    } catch (error) {
      setAuthSession(null);
      const message = error?.message || "Wallet authentication failed.";
      setAuthenticationError(message);
      return { error: message, code: error?.code || "AUTH_REQUEST_FAILED" };
    } finally {
      setAuthenticating(false);
    }
  }, [account, chainId]);

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
        setOwned({ cchain: new Set(), grotto: new Set() });
        setOwnershipRecords([]);
      } else {
        clearAuthentication();
        setAccount(accts[0]);
        refreshOwnership(accts[0]);
      }
    };
    const onChainChanged = (cid) => {
      clearAuthentication();
      setChainId(parseInt(cid, 16));
    };

    provider.on?.("accountsChanged", onAccountsChanged);
    provider.on?.("chainChanged", onChainChanged);
    listenersRef.current = { provider, onAccountsChanged, onChainChanged };
  }, [clearAuthentication, refreshOwnership, unwireProvider]);

  const connect = useCallback(async (provider) => {
    const p = provider || providerRef.current || window.ethereum;
    if (!p) return { error: "No wallet detected. Install MetaMask or Core." };
    try {
      const accts = await p.request({ method: "eth_requestAccounts" });
      if (!accts || !accts.length) return { error: "No accounts returned." };
      const cid = await p.request({ method: "eth_chainId" });
      setAccount(accts[0]);
      const selectedChainId = parseInt(cid, 16);
      setChainId(selectedChainId);
      wireProvider(p);
      refreshOwnership(accts[0]);
      return authenticate({ targetProvider: p, wallet: accts[0], selectedChainId });
    } catch {
      return { error: "Connection rejected." };
    }
  }, [wireProvider, refreshOwnership, authenticate]);

  const disconnect = useCallback(() => {
    unwireProvider();
    clearAuthentication();
    setAccount(null);
    setChainId(null);
    setOwned({ cchain: new Set(), grotto: new Set() });
    setOwnershipRecords([]);
    providerRef.current = null;
    setProvider(null);
  }, [clearAuthentication, unwireProvider]);

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
          refreshOwnership(accts[0]);
        }
      } catch {
        // not connected — expected
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Detach provider listeners if the provider tree unmounts.
  useEffect(() => unwireProvider, [unwireProvider]);

  const value = {
    wallets,
    account,
    chainId,
    owned,
    ownershipRecords,
    identity,
    loadingOwnership,
    connected: !!account,
    authenticated: !!authSession,
    authenticating,
    authenticationError,
    authSession,
    authHeaders: authorizationHeaders(authSession),
    provider,
    getProvider: () => providerRef.current || window.ethereum,
    connect,
    authenticate,
    disconnect,
    refreshOwnership,
  };

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}
