import { useState } from "react";
import { Link } from "react-router-dom";
import { Eyebrow } from "./Atoms.jsx";
import { useMarketplaceCatalogs } from "../lib/catalog-source.js";
import { releaseCoverSources } from "../lib/release-cover.js";
import { collapsePublicCatalog } from "../lib/summit-demo.js";
import { marketplaceCatalog } from "../lib/marketplace-surface.js";
import { ghostBtn } from "../lib/marketplace-chrome.js";

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

export function ReleaseCover({ sources, title }) {
  const [index, setIndex] = useState(0);
  const src = sources[index];
  if (!src) {
    return <div className="vc-home-relic-blank" role="img" aria-label={`${title}: artwork unavailable`}><span>No artwork</span></div>;
  }
  return <img src={src} alt={`${title} artwork`} loading="lazy" decoding="async" onError={() => setIndex((current) => current + 1)} />;
}

// Homepage shelf: the catalog's real releases, presented as numbered objects in the archive.
// Reads the same catalog as Discover; it states nothing about sale or ownership.
export function HomeArchive() {
  const catalog = useMarketplaceCatalogs();
  const records = marketplaceCatalog([collapsePublicCatalog(catalog)]);
  return (
    <section className="vc-home-archive" aria-labelledby="home-archive-heading">
      <div className="vc-home-archive-head">
        <div>
          <Eyebrow red>† The archive</Eyebrow>
          <h2 id="home-archive-heading">Records in the Void</h2>
          <p>Every release is kept here as an object: artwork, tracklist, editions, and the experiences its collectors unlock.</p>
        </div>
        <div className="vc-home-archive-actions">
          <Link to="/discover" style={ghostBtn}>Discover</Link>
          <Link to="/reliquary" style={ghostBtn}>Your reliquary</Link>
        </div>
      </div>
      {records.length > 0 ? (
        <div className="vc-home-shelf">
          {records.map((record, index) => (
            <Link key={record.release.id} to={`/release/${record.release.id}`} className="vc-home-relic">
              <figure>
                <ReleaseCover key={record.release.id} sources={releaseCoverSources(record)} title={record.release.title} />
              </figure>
              <div className="vc-home-relic-copy">
                <span className="vc-home-relic-index">Relic {ROMAN[index] || index + 1} · {record.artist?.name || "The Void"}</span>
                <h3>{record.release.title}</h3>
                {(record.release.subtitle || record.release.description) && <p>{record.release.subtitle || record.release.description}</p>}
              </div>
            </Link>
          ))}
        </div>
      ) : catalog.publishedLoading ? (
        <p role="status" className="vc-card-meta">Loading the archive…</p>
      ) : (
        <div className="vc-empty-rail" role="status">
          <Eyebrow>The archive is quiet</Eyebrow>
          <p className="vc-card-body" style={{ marginTop: 10 }}>No release is published yet. New records appear here when they are.</p>
        </div>
      )}
    </section>
  );
}
