// The Void brand lockup for the dark site header (supplied 05-Web-App brand kit).
// Narrow viewports swap to the symbol-only nav mark so the lockup never crowds the menu button.
// Supplied naming: "-dark" files are the light-ink artwork made for dark backgrounds.
const LOCKUP = { src: "/brand/the-void/header-lockup-dark.svg", width: 210, height: 38 };
const MARK = { src: "/brand/the-void/nav-symbol-dark-64.png", width: 36, height: 36 };
const COMPACT_QUERY = "(max-width: 420px)";

export function BrandLogo({ alt = "The Void" }) {
  return (
    <picture>
      <source media={COMPACT_QUERY} srcSet={MARK.src} width={MARK.width} height={MARK.height} />
      <img src={LOCKUP.src} alt={alt} width={LOCKUP.width} height={LOCKUP.height} style={{ display: "block" }} />
    </picture>
  );
}
