// The Void brand lockup for the dark site header (supplied 05-Web-App brand kit).
// At mobile widths prefer the official horizontal lockup, scaled proportionally so it
// never crowds the menu button. On the narrowest viewports where the lockup cannot
// fit beside the menu button, fall back to the official wordmark-only asset.
// Desktop appearance is preserved (full-size lockup).
// Supplied naming: "-dark" files are the light-ink artwork made for dark backgrounds.
const LOCKUP = { src: "/brand/the-void/header-lockup-dark.svg", width: 210, height: 38 };
const WORDMARK = { src: "/brand/the-void/header-wordmark-dark.svg", width: 148, height: 38 };
const COMPACT_QUERY = "(max-width: 300px)";

export function BrandLogo({ alt = "The Void" }) {
  return (
    <picture>
      <source media={COMPACT_QUERY} srcSet={WORDMARK.src} width={WORDMARK.width} height={WORDMARK.height} />
      <img
        src={LOCKUP.src}
        alt={alt}
        width={LOCKUP.width}
        height={LOCKUP.height}
        style={{
          display: "block",
          maxWidth: "min(210px, calc(100vw - 84px))",
          height: "auto",
          width: "auto",
        }}
      />
    </picture>
  );
}
