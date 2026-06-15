import { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { checkOwnership } from "./web3.js";
import { VC_AUDIO } from "./audio.js";

const WalletCtx = createContext(null);
export function useWallet() {
  return useContext(WalletCtx);
}

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

export function WalletProvider({ children }) {
  const [wallets, setWallets] = useState([]); // detected providers
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [owned, setOwned] = useState({ cchain: new Set(), grotto: new Set() });
  const [loadingOwnership, setLoadingOwnership] = useState(false);
  const providerRef = useRef(null);

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
    if (!target) { setOwned({ cchain: new Set(), grotto: new Set() }); return; }
    setLoadingOwnership(true);
    try {
      const result = await checkOwnership(target);
      setOwned(result);
    } finally {
      setLoadingOwnership(false);
    }
  }, [account]);

  const wireProvider = useCallback((provider) => {
    providerRef.current = provider;
    provider.on?.("accountsChanged", (accts) => {
      if (!accts || accts.length === 0) {
        setAccount(null);
        setOwned({ cchain: new Set(), grotto: new Set() });
      } else {
        setAccount(accts[0]);
        refreshOwnership(accts[0]);
      }
    });
    provider.on?.("chainChanged", (cid) => setChainId(parseInt(cid, 16)));
  }, [refreshOwnership]);

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
      return { ok: true };
    } catch {
      return { error: "Connection rejected." };
    }
  }, [wireProvider, refreshOwnership]);

  const disconnect = useCallback(() => {
    setAccount(null);
    setChainId(null);
    setOwned({ cchain: new Set(), grotto: new Set() });
    providerRef.current = null;
  }, []);

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

  const value = {
    wallets,
    account,
    chainId,
    owned,
    loadingOwnership,
    connected: !!account,
    provider: providerRef.current,
    getProvider: () => providerRef.current || window.ethereum,
    connect,
    disconnect,
    refreshOwnership,
  };

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}
