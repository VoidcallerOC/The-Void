// Voidcaller brand lockup for the dark site header (white/red artwork, supplied brand kit v1.2).
// Narrow viewports swap to the symbol-only nav mark so the lockup never crowds the menu button.
// Supplied naming: "-dark" files are the light-ink artwork made for dark backgrounds.
const LOCKUP = { src: "/brand/header-lockup-dark.svg", width: 131, height: 56 };
const MARK = { src: "/brand/nav-mark-dark.svg", width: 31, height: 40 };
const COMPACT_QUERY = "(max-width: 420px)";

export function BrandLogo({ alt = "VOIDCALLER" }) {
  return (
    <picture>
      <source media={COMPACT_QUERY} srcSet={MARK.src} width={MARK.width} height={MARK.height} />
      {/* The lockup artwork carries its own transparent margin; the negative margin keeps header height unchanged. */}
      <img src={LOCKUP.src} alt={alt} width={LOCKUP.width} height={LOCKUP.height} style={{ display: "block", margin: "-8px 0" }} />
    </picture>
  );
}
