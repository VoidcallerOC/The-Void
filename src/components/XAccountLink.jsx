import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "../lib/wallet-context.js";
import { WalletButton } from "./WalletButton.jsx";
import { ghostBtn } from "../lib/marketplace-chrome.js";
import { X_LINK_MESSAGE, completeXLink, disconnectXLink, fetchXLink, startXLink } from "../lib/x-link-api.js";

const panel = { border: "1px solid var(--vc-bone-dim)", padding: "20px clamp(16px, 3vw, 28px)", display: "grid", gap: 12, maxWidth: 720 };
const mono = { fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase" };
const dim = { color: "var(--vc-bone-dim)", lineHeight: 1.7, margin: 0 };

function XLogo() {
  return <svg className="vc-x-connect__logo" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>;
}

// Optional X identity link. Signing in with a wallet stays the only way in; this just shows
// which X account the wallet owner has proven they control. Authorization happens on X's own page.
// variant="nav" renders only the connect action for the header, next to the wallet button. It is the same
// component and the same connect() flow as the panel, so there is one OAuth path, not a copy of it.
export function XAccountLink({ variant = "panel" } = {}) {
  const wallet = useWallet();
  const headers = wallet?.authHeaders || {};
  const signedIn = Boolean(wallet?.connected && wallet?.authenticated && headers.authorization);
  const [state, setState] = useState({ phase: "idle", link: null, error: "" });
  const popup = useRef(null);
  const busy = useRef(false);
  const headersRef = useRef(headers);
  headersRef.current = headers;

  const refresh = useCallback(async () => {
    try {
      const link = await fetchXLink({ headers: headersRef.current });
      setState({ phase: link.connected ? "connected" : link.available === false ? "unavailable" : "disconnected", link, error: "" });
    } catch (error) {
      setState({ phase: "error", link: null, error: error.message });
    }
  }, []);

  useEffect(() => {
    if (!signedIn) { setState({ phase: "idle", link: null, error: "" }); return undefined; }
    setState((s) => ({ ...s, phase: "loading" }));
    void refresh();
    return undefined;
  }, [signedIn, headers.authorization, refresh]);

  useEffect(() => {
    async function onMessage(event) {
      if (event.origin !== window.location.origin || event.data?.type !== X_LINK_MESSAGE || event.source !== popup.current) return;
      const { code, state: oauthState, error } = event.data;
      popup.current = null;
      try {
        const link = await completeXLink({ code, state: oauthState, error, headers: headersRef.current });
        setState({ phase: "connected", link, error: "" });
      } catch (err) {
        setState((s) => ({ phase: s.link?.connected ? "connected" : "disconnected", link: s.link, error: err.message }));
      } finally { busy.current = false; }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function connect() {
    if (busy.current) return;
    busy.current = true;
    setState((s) => ({ ...s, phase: "pending", error: "" }));
    // Open synchronously from the click so the browser does not block the window.
    const win = window.open("about:blank", "void-x-link", "popup,width=520,height=720");
    if (!win) { busy.current = false; setState((s) => ({ ...s, phase: s.link?.connected ? "connected" : "disconnected", error: "Your browser blocked the X window. Allow pop-ups for this site and try again." })); return; }
    popup.current = win;
    try {
      const { authorizationUrl } = await startXLink({ headers: headersRef.current });
      win.location.href = authorizationUrl;
    } catch (error) {
      win.close(); popup.current = null; busy.current = false;
      setState((s) => ({ ...s, phase: s.link?.connected ? "connected" : "disconnected", error: error.message }));
      return;
    }
    const timer = window.setInterval(() => {
      if (!popup.current || popup.current.closed) {
        window.clearInterval(timer);
        // Closed without a callback: the user cancelled. Nothing was connected.
        if (popup.current) { popup.current = null; busy.current = false; setState((s) => ({ ...s, phase: s.link?.connected ? "connected" : "disconnected", error: "X connection cancelled. Nothing was changed." })); }
      }
    }, 600);
  }

  async function disconnect() {
    if (busy.current) return;
    busy.current = true;
    try {
      await disconnectXLink({ headers: headersRef.current });
      setState({ phase: "disconnected", link: { connected: false, available: true }, error: "" });
    } catch (error) {
      setState((s) => ({ ...s, error: error.message }));
    } finally { busy.current = false; }
  }

  if (variant === "nav") {
    // The header shows where the X link stands, so it never looks missing: connect, linked, unavailable or retry.
    // It needs a wallet session to link, so it renders nothing before sign-in and while the status loads.
    const { phase, link, error } = state;
    if (!signedIn || phase === "idle" || phase === "loading") return null;
    if (phase === "connected" && link) {
      return <a className="vc-x-chip vc-x-chip--linked" href={link.profileUrl} target="_blank" rel="noopener noreferrer" title="X account connected"><XLogo />@{link.username}</a>;
    }
    if (phase === "unavailable") {
      return <span className="vc-x-chip" title="Connecting an X account is not available right now."><XLogo />X unavailable</span>;
    }
    if (phase === "error") {
      return <button type="button" className="vc-x-chip" onClick={refresh} title={error || "Could not check your X connection."}><XLogo />X retry</button>;
    }
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
        <button type="button" className="vc-x-connect vc-x-connect--nav" onClick={connect} disabled={phase === "pending"} aria-busy={phase === "pending"} aria-label="Connect X account" title="Connect your X account (optional)">
          <XLogo /><span aria-hidden="true">{phase === "pending" ? "Waiting for X…" : "Connect X"}</span>
        </button>
        {error && <span role="alert" style={{ ...mono, fontSize: 10, color: "var(--vc-crimson)", maxWidth: 220, lineHeight: 1.4, textTransform: "none", letterSpacing: ".04em" }}>{error}</span>}
      </span>
    );
  }

  if (!signedIn) {
    // Never hide silently: say what is needed. Linking needs a signed wallet session, because the wallet
    // stays the only way in and the link is stored against it.
    const reason = !wallet?.connected
      ? "Connect your wallet to link an X account."
      : wallet.needsNetworkSwitch
        ? `Switch your wallet to ${wallet.releaseNetworkName || "the release network"}, then sign in to link an X account.`
        : "Sign in with your wallet to link an X account.";
    return (
      <section style={panel} aria-label="X account">
        <span style={{ ...mono, color: "var(--vc-crimson)" }}>† X account · optional</span>
        <p style={dim}>Connect X to show a verified link to your X profile. {reason} Linking is optional and does not change your wallet, collection or marketplace access.</p>
        {wallet?.authenticationError && <p role="alert" style={{ ...dim, color: "var(--vc-crimson)" }}>{wallet.authenticationError}</p>}
        <div><WalletButton /></div>
      </section>
    );
  }
  const { phase, link, error } = state;
  return (
    <section style={panel} aria-label="X account">
      <span style={{ ...mono, color: "var(--vc-crimson)" }}>† X account · optional</span>
      {phase === "loading" && <p style={dim}>Checking your X connection…</p>}
      {phase === "unavailable" && <p style={dim}>Connecting an X account is not available right now. Everything else works as usual.</p>}
      {(phase === "disconnected" || phase === "pending") && (
        <>
          <p style={dim}>Connect your X account to show a verified link to your X profile. This is optional. We will store your X user ID, username, display name and profile image link. You sign in on X itself, we never see your password, and connecting does not change your wallet, collection or marketplace access.</p>
          <div style={{ marginTop: 4 }}><button type="button" className="vc-x-connect" onClick={connect} disabled={phase === "pending"} aria-busy={phase === "pending"}><XLogo /><span>{phase === "pending" ? "Waiting for X…" : "Connect X account"}</span></button></div>
        </>
      )}
      {phase === "connected" && link && (
        <>
          <p style={{ ...dim, color: "var(--vc-bone)" }}>
            <span style={mono}>Status: {link.status === "CONNECTED" ? "Connected" : link.status}</span><br />
            <a href={link.profileUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--vc-bone)" }}>@{link.username}</a>
            {link.displayName ? ` · ${link.displayName}` : ""}
          </p>
          <p style={dim}>Verified {new Date(link.verifiedAt).toLocaleDateString()}. Only you can disconnect it.</p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button type="button" style={ghostBtn} onClick={connect}>Refresh from X</button>
            <button type="button" style={ghostBtn} onClick={disconnect}>Disconnect X account</button>
          </div>
        </>
      )}
      {phase === "error" && <div><button type="button" style={ghostBtn} onClick={refresh}>Retry</button></div>}
      {error && <p role="alert" style={{ ...dim, color: "var(--vc-crimson)" }}>{error}</p>}
    </section>
  );
}
