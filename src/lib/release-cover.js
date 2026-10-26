import { RELEASE_ARTWORK_FALLBACK } from "./catalog-source.js";
import { artworkSources } from "./artwork.js";

// A release's own cover: its stored artwork, else its first edition's token image. The catalog's
// generic site image is not a cover, so a release with neither gets a neutral plate instead.
export function releaseCoverSources(record) {
  const own = record.release?.artwork && record.release.artwork !== RELEASE_ARTWORK_FALLBACK ? record.release.artwork : "";
  const edition = record.editions?.find((item) => item.edition?.artwork)?.edition.artwork || "";
  return [...new Set([...artworkSources(own), ...artworkSources(edition)])];
}
