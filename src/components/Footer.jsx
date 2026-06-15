import { VC_DATA } from "../data.js";
import { Eyebrow } from "./Atoms.jsx";

// ---------------- Footer ----------------
export function Footer() {
  return (
    <footer
      style={{
        background: "var(--vc-void)",
        borderTop: "1px solid var(--vc-ash)",
        padding: "clamp(40px, 8vw, 64px) clamp(20px, 6vw, 64px) 48px",
      }}
    >
      <div className="vc-footer-grid" style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 48 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <img src="/assets/VoidcallerLogo.gif" style={{ width: 40, height: 40 }} alt="" />
            <img src="/assets/voidcaller_wordmark.png" alt="VOIDCALLER" style={{ height: 26, width: "auto", display: "block" }} />
          </div>
          <p style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--vc-bone-dim)", maxWidth: 380, lineHeight: 1.6, margin: 0 }}>
            On-chain metalcore. Music as ritual, NFT as relic. The chain remembers.
          </p>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--vc-bone-dim)",
              padding: "10px 12px",
              border: "1px solid var(--vc-ash)",
              maxWidth: 380,
              wordBreak: "break-all",
            }}
          >
            <span style={{ color: "var(--vc-crimson)" }}>contract › </span>
            {VC_DATA.contract}
          </div>
        </div>
        {[
          ["THE RELIC", [
            { label: "I · Voidcaller (EP)", href: VC_DATA.marketplaces.find(m => m.name === "OPENSEA").href },
            { label: "II · Forthcoming" },
          ]],
          ["THE CHOIR", VC_DATA.socials.map(s => ({ label: s.name, href: s.href }))],
          ["THE LEDGER", VC_DATA.marketplaces.map(m => ({
            label: m.name === "SNOWTRACE" ? "Snowtrace" : m.name === "OPENSEA" ? "OpenSea (Avalanche)" : "Joepegs",
            href: m.href,
          }))],
        ].map(([head, items]) => (
          <div key={head}>
            <Eyebrow>{head}</Eyebrow>
            <ul style={{ listStyle: "none", padding: 0, margin: "18px 0 0", display: "flex", flexDirection: "column", gap: 10 }}>
              {items.map(({ label, href }) => (
                <li key={label}>
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        fontFamily: "var(--font-body)",
                        fontWeight: 500,
                        fontSize: 13,
                        color: "var(--vc-bone)",
                        textDecoration: "none",
                        transition: "color 120ms",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = "var(--vc-crimson)";
                        e.currentTarget.style.textDecoration = "underline";
                        e.currentTarget.style.textDecorationColor = "var(--vc-crimson)";
                        e.currentTarget.style.textDecorationThickness = "1px";
                        e.currentTarget.style.textUnderlineOffset = "5px";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = "var(--vc-bone)";
                        e.currentTarget.style.textDecoration = "none";
                      }}
                    >
                      {label}
                    </a>
                  ) : (
                    <span style={{ fontFamily: "var(--font-body)", fontWeight: 500, fontSize: 13, color: "var(--vc-bone-dim)" }}>
                      {label}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="vc-footer-bottom" style={{ marginTop: 64, paddingTop: 24, borderTop: "1px solid var(--vc-ash)", display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.18em", color: "var(--vc-bone-dim)", textTransform: "uppercase" }}>
          © MMXXVI · VOIDCALLER · ALL BLEEDS RESERVED
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.18em", color: "var(--vc-bone-dim)", textTransform: "uppercase" }}>
          † AT REST IN THE VOID †
        </span>
      </div>
    </footer>
  );
}
