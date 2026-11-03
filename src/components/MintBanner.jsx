import { Link } from "react-router-dom";
import { timeLeftLabel } from "../lib/featured-mint.js";

/**
 * Site-wide strip above the header while a release is minting: on every page, the first thing a visitor
 * sees is that something is for sale, at what price, and for how long. Rendered by Layout only when the
 * featured-mint helper finds an open sale, so it disappears on its own when the sale closes.
 */
export function MintBanner({ featured }) {
  const left = timeLeftLabel(featured.endTime);
  return (
    <Link to={featured.href} className="vc-mint-banner" data-testid="mint-banner" aria-label={`Minting now: ${featured.title}${featured.price ? `, ${featured.price}` : ""}${left ? `, ${left}` : ""}. Mint now.`}>
      <span className="vc-mint-banner-dot" aria-hidden="true" />
      <span className="vc-mint-banner-text">
        <strong>Minting now</strong>
        <span>{featured.title}</span>
        {featured.price && <span>{featured.price}</span>}
        {left && <span className="vc-mint-banner-left">{left}</span>}
      </span>
      <span className="vc-mint-banner-cta">Mint →</span>
    </Link>
  );
}
