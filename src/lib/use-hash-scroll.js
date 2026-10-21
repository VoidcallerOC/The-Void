import { useEffect } from "react";
import { useLocation } from "react-router-dom";

// React Router does not scroll to a URL fragment, and Layout's ScrollToTop scrolls to the top on every path
// change. A link such as /edition/:id#secondary-listing therefore landed at the top of the page (from another
// route) or did nothing at all (from the same edition, where only the hash changes). This scrolls to the
// fragment's element once `ready` says the page has rendered it. The frame runs after the same commit's
// ScrollToTop, and `location.key` re-runs it when the same link is followed again.
export function useHashScroll(targetId, ready) {
  const location = useLocation();
  useEffect(() => {
    if (!ready || location.hash !== `#${targetId}` || typeof window === "undefined") return undefined;
    const frame = window.requestAnimationFrame(() => {
      // scroll-margin-top on the target keeps it clear of the sticky header.
      document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [targetId, ready, location.hash, location.pathname, location.key]);
}
