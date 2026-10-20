import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { ghostBtn, primaryBtn, shell } from "../lib/marketplace-chrome.js";
import { NOT_FOUND_TITLE, setPageTitleOverride } from "../lib/page-title.js";

// An address that does not resolve says so, keeps its URL, and offers the
// nearest real page. It never silently swaps in a different page: that made
// broken or not-yet-published links look like "the site repeating itself".
export function NotFoundPage({ kind = "page", backTo = "/", backLabel = "Back to The Void" } = {}) {
  const { pathname } = useLocation();
  // While this page is mounted the document title reads as not found, whatever the route kind.
  useEffect(() => {
    setPageTitleOverride(NOT_FOUND_TITLE);
    return () => setPageTitleOverride(null);
  }, []);
  return (
    <section style={shell} data-testid="not-found" data-not-found-kind={kind}>
      <Eyebrow red>† Not found</Eyebrow>
      <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(40px, 8vw, 80px)", lineHeight: 0.92, textTransform: "uppercase", margin: "16px 0" }}>
        {kind === "page" ? "Nothing at this address" : `This ${kind} isn't available`}
      </h1>
      <p style={{ color: "var(--vc-bone-dim)", maxWidth: 600 }}>
        <span style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{pathname}</span>{" "}
        {kind === "page"
          ? "is not a page on The Void."
          : `doesn't match a published ${kind}. It may not be published yet, or the link may be wrong.`}
      </p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 24 }}>
        <Link to={backTo} style={primaryBtn}>{backLabel}</Link>
        {backTo !== "/" && <Link to="/" style={ghostBtn}>Home</Link>}
      </div>
    </section>
  );
}
