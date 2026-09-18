export const shell = {
  maxWidth: 1360,
  width: "100%",
  margin: "0 auto",
  padding: "104px clamp(16px, 4vw, 56px) 96px",
};

export const contentShell = {
  maxWidth: 1360,
  width: "100%",
  margin: "0 auto",
  padding: "48px clamp(16px, 4vw, 56px) 96px",
};

export const ghostBtn = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 48,
  minWidth: 148,
  border: "1px solid var(--vc-bone-dim)",
  color: "var(--vc-bone)",
  padding: "14px 20px",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  letterSpacing: ".14em",
  textTransform: "uppercase",
  textDecoration: "none",
  background: "transparent",
  cursor: "pointer",
};

export const primaryBtn = {
  ...ghostBtn,
  border: "1px solid var(--vc-crimson)",
  background: "var(--vc-crimson)",
  color: "#fff",
  boxShadow: "0 0 32px -8px rgba(225,15,31,0.55)",
};

export function artworkFor(edition, release) {
  return edition?.artwork || release?.artwork || "/assets/voidcaller_art_4.png";
}
