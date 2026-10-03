import { useEffect, useRef, useState } from "react";
import { useWallet } from "../lib/wallet-context.js";
import { fetchMarketplacePresentationEditor, saveMarketplacePresentation } from "../lib/marketplace-api.js";
import { validateMarketplaceArtwork } from "../lib/marketplace-presentation.js";
import { ghostBtn, primaryBtn } from "../lib/marketplace-chrome.js";

// Shown only to wallets the server lists in MARKETPLACE_ADMIN_WALLETS. The
// server re-checks on save; hiding the form is convenience, not protection.
export function MarketplaceHeroEditor({ current, onSaved }) {
  const wallet = useWallet() || {};
  const [admin, setAdmin] = useState(false);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [state, setState] = useState({ busy: false, message: "" });
  const authKey = wallet.authenticated ? String(wallet.account || "").toLowerCase() : "";
  // authHeaders is rebuilt on every wallet render; check admin once per wallet.
  const headersRef = useRef(wallet.authHeaders);
  useEffect(() => { headersRef.current = wallet.authHeaders; });

  useEffect(() => {
    if (!authKey) return undefined;
    const controller = new AbortController();
    fetchMarketplacePresentationEditor({ authHeaders: headersRef.current, signal: controller.signal })
      .then((result) => setAdmin(Boolean(result?.admin)))
      .catch(() => setAdmin(false));
    return () => controller.abort();
  }, [authKey]);

  if (!authKey || !admin) return null;

  const save = async (heroArtwork) => {
    const checked = validateMarketplaceArtwork(heroArtwork);
    if (!checked.ok) { setState({ busy: false, message: checked.error }); return; }
    setState({ busy: true, message: "" });
    try {
      const saved = await saveMarketplacePresentation({ heroArtwork: checked.value, authHeaders: wallet.authHeaders });
      onSaved?.(saved);
      setOpen(false);
      setState({ busy: false, message: checked.value ? "Header artwork saved." : "Header artwork cleared." });
    } catch (error) {
      setState({ busy: false, message: error?.message || "Could not save the header artwork." });
    }
  };

  return (
    <div className="vc-market-hero-editor" style={{ marginTop: 14 }}>
      {!open ? (
        <button type="button" style={ghostBtn} onClick={() => { setValue(current || ""); setOpen(true); }}>Admin · Header artwork</button>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); void save(value); }} style={{ display: "grid", gap: 8, maxWidth: 520 }}>
          <label htmlFor="market-hero-artwork" className="vc-card-meta">Header artwork (ipfs://, https:// or /assets/ path)</label>
          <input id="market-hero-artwork" value={value} onChange={(event) => setValue(event.target.value)} placeholder="ipfs://…" style={{ padding: 10, background: "var(--vc-void)", color: "var(--vc-bone)", border: "1px solid var(--vc-ash)" }} />
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button type="submit" style={primaryBtn} disabled={state.busy}>{state.busy ? "Saving…" : "Save"}</button>
            <button type="button" style={ghostBtn} disabled={state.busy} onClick={() => void save("")}>Clear</button>
            <button type="button" style={ghostBtn} disabled={state.busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
      {state.message && <p role="status" className="vc-card-meta" style={{ marginTop: 8 }}>{state.message}</p>}
    </div>
  );
}
