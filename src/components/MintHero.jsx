import { Link } from "react-router-dom";
import { useAudio } from "../lib/audio.js";
import { mintLabel, timeLeftLabel } from "../lib/featured-mint.js";
import { ghostBtn, primaryBtn } from "../lib/marketplace-chrome.js";
import { TokenArtwork } from "./TokenArtwork.jsx";

/**
 * The home page's first screen while a release is minting: the release itself (cover, title, price, time
 * left, Mint), not the archive. Everything shown is read from the catalog and the release's sale contract.
 */
export function MintHero({ featured }) {
  const audio = useAudio();
  const left = timeLeftLabel(featured.endTime);
  const hear = () => {
    if (!featured.preview) return;
    audio.setQueue([featured.preview], `preview:${featured.edition.id}`, featured.title);
    audio.play(0);
  };
  return (
    <section className="vc-mint-hero" data-testid="mint-hero" aria-labelledby="mint-hero-title">
      <div className="vc-mint-hero-copy">
        <p className="vc-mint-hero-kicker"><span className="vc-mint-banner-dot" aria-hidden="true" /> New release · minting now</p>
        <p className="vc-mint-hero-artist">{featured.artist?.name || "Voidcaller"}</p>
        <h2 id="mint-hero-title" className="vc-mint-hero-title">{featured.title}</h2>
        {(featured.release?.subtitle || featured.release?.description) && <p className="vc-mint-hero-line">{featured.release.subtitle || featured.release.description}</p>}
        <dl className="vc-mint-hero-facts">
          {featured.price && <div><dt>Price</dt><dd>{featured.price}</dd></div>}
          {left && <div><dt>Closes</dt><dd>{left}</dd></div>}
          <div><dt>Edition</dt><dd>Open edition</dd></div>
        </dl>
        <div className="vc-mint-hero-actions">
          <Link to={featured.href} style={{ ...primaryBtn, minHeight: 56, padding: "0 32px", fontSize: 14 }}>{mintLabel(featured)}</Link>
          {featured.preview && <button type="button" onClick={hear} style={{ ...ghostBtn, minHeight: 56, cursor: "pointer" }}>▶ Hear it first</button>}
        </div>
        {featured.saleLabel && <p className="vc-mint-hero-fine">{featured.saleLabel}</p>}
      </div>
      <Link to={featured.href} className="vc-mint-hero-art" aria-label={`${featured.title}: open the mint page`}>
        <TokenArtwork sources={featured.artwork} alt={`${featured.title} cover`} />
      </Link>
    </section>
  );
}
