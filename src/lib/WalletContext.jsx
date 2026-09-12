import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { checkOwnership, checkCollectionOwnership, checkOwnershipRecords, checkCollectionOwnershipRecords, choirIdentity } from "./web3.js";
import { VC_AUDIO } from "./audio.js";
import { WalletCtx } from "./wallet-context.js";

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
  const [authenticated, setAuthenticated] = useState(false);
  const [authError, setAuthError] = useState(null);
  const expectedChainId = Number(import.meta.env.VITE_AUTH_CHAIN_ID || 43113);
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

  const invalidateAuth = useCallback(() => { setAuthenticated(false); setAuthError(null); }, []);

  const authenticate = useCallback(async (p, address, cid) => {
    if (cid !== expectedChainId) return { error: `Switch to the ${expectedChainId === 43114 ? "Avalanche C-Chain" : "Avalanche Fuji"} network.` };
    try {
      const challengeResponse = await fetch(`/api/auth/challenge?wallet=${encodeURIComponent(address)}&purpose=wallet-login`, { credentials: "include" });
      const challengePayload = await challengeResponse.json();
      if (!challengeResponse.ok) throw new Error(challengePayload.error?.message || "Challenge request failed.");
      const signature = await p.request({ method: "personal_sign", params: [challengePayload.data.message, address] });
      const verifyResponse = await fetch("/api/auth/verify", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: address, signature, nonce: challengePayload.data.nonce, purpose: "wallet-login" }) });
      const verifyPayload = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(verifyPayload.error?.message || "Signature verification failed.");
      setAuthenticated(true); setAuthError(null); return { ok: true };
    } catch (error) { const message = error?.message || "Wallet authentication failed."; setAuthenticated(false); setAuthError(message); return { error: message }; }
  }, [expectedChainId]);

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
        setAccount(null);
        invalidateAuth();
        setOwned({ cchain: new Set(), grotto: new Set() });
        setOwnershipRecords([]);
      } else {
        invalidateAuth();
        setAccount(accts[0]);
        refreshOwnership(accts[0]);
      }
    };
    const onChainChanged = (cid) => { setChainId(parseInt(cid, 16)); invalidateAuth(); };

    provider.on?.("accountsChanged", onAccountsChanged);
    provider.on?.("chainChanged", onChainChanged);
    listenersRef.current = { provider, onAccountsChanged, onChainChanged };
  }, [invalidateAuth, refreshOwnership, unwireProvider]);

  const connect = useCallback(async (provider) => {
    const p = provider || providerRef.current || window.ethereum;
    if (!p) return { error: "No wallet detected. Install MetaMask or Core." };
    try {
      const accts = await p.request({ method: "eth_requestAccounts" });
      if (!accts || !accts.length) return { error: "No accounts returned." };
      const cid = await p.request({ method: "eth_chainId" });
      setAccount(accts[0]);
      setChainId(parseInt(cid, 16));
      wireProvider(p);
      refreshOwnership(accts[0]);
      return authenticate(p, accts[0], parseInt(cid, 16));
    } catch {
      return { error: "Connection rejected." };
    }
  }, [authenticate, wireProvider, refreshOwnership]);

  const disconnect = useCallback(() => {
    unwireProvider();
    setAccount(null);
    setChainId(null);
    invalidateAuth();
    setOwned({ cchain: new Set(), grotto: new Set() });
    setOwnershipRecords([]);
    providerRef.current = null;
    setProvider(null);
  }, [invalidateAuth, unwireProvider]);

  // restore an already-authorized session on load
  useEffect(() => {
    if (!window.ethereum) return;
    (async () => {
      try {
        const accts = await window.ethereum.request({ method: "eth_accounts" });
        if (accts && accts.length) {
          const cid = await window.ethereum.request({ method: "eth_chainId" });
          setAccount(accts[0]);
          const numericChainId = parseInt(cid, 16);
          setChainId(numericChainId);
          wireProvider(window.ethereum);
          refreshOwnership(accts[0]);
          if (numericChainId === expectedChainId) {
            const session = await fetch("/api/auth/session", { credentials: "include" });
            setAuthenticated(session.ok);
          }
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
    authenticated,
    authError,
    provider,
    getProvider: () => providerRef.current || window.ethereum,
    connect,
    disconnect,
    refreshOwnership,
  };

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}
