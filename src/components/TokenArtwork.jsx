import { useState } from "react";

// Shows the first artwork source that loads: the token's own image, then the
// collection's, so a slow or missing token image never leaves a blank tile.
export function TokenArtwork({ sources = [], alt = "", style }) {
  const [index, setIndex] = useState(0);
  const src = sources[index];
  if (!src) return null;
  return <img src={src} alt={alt} loading="lazy" style={style} onError={() => setIndex((current) => (current + 1 < sources.length ? current + 1 : current))} />;
}
