import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { shell } from "../lib/marketplace-chrome.js";
import { X_LINK_MESSAGE } from "../lib/x-link-api.js";

// /x/callback — the exact redirect URI registered with X. It never talks to the API and holds no
// wallet session: it only hands { code, state | error } to the window that started the connection,
// which finishes it with its own Void session. The query is removed from the URL immediately.
export function XLinkCallbackPage() {
  const [message] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return { type: X_LINK_MESSAGE, code: params.get("code"), state: params.get("state"), error: params.get("error") };
  });
  const canHandOff = Boolean(window.opener && !window.opener.closed && (message.code || message.error));
  useEffect(() => {
    window.history.replaceState(null, "", window.location.pathname);
    if (!canHandOff) return;
    window.opener.postMessage(message, window.location.origin);
    window.close();
  }, [message, canHandOff]);
  return (
    <section style={shell}>
      <h1 style={{ fontFamily: "var(--font-display)", textTransform: "uppercase" }}>X connection</h1>
      <p style={{ color: "var(--vc-bone-dim)", maxWidth: 520, lineHeight: 1.7 }}>
        {canHandOff ? "Returning to The Void. You can close this window." : "This window cannot finish the connection. Return to The Void and choose Connect X account again."}
      </p>
      <Link to="/my-collection" style={{ color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>← Back to The Void</Link>
    </section>
  );
}
