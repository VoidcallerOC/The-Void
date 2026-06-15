import { VC_DATA } from "../data.js";
import { Eyebrow, Btn, Tag } from "./Atoms.jsx";
import { Glitch } from "./Overlays.jsx";

const DISCORD = VC_DATA.socials.find((s) => s.name === "Discord").href;

// ---------------- The Covenant ($VOID presale) ----------------
// Staged section — only mounted when VOID_LIVE is true (see App.jsx / data.js).
export function Covenant() {
  const p = VC_DATA.voidPresale;
  return (
    <section
      id="covenant"
      style={{
        position: "relative",
        padding: "clamp(64px, 12vw, 128px) clamp(20px, 6vw, 64px)",
        borderTop: "1px solid var(--vc-ash)",
        background: "linear-gradient(180deg, var(--vc-pit) 0%, var(--vc-void) 100%)",
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 12 }}>
          <Tag kind="crimson" pulse>THE COVENANT APPROACHES</Tag>
          <Eyebrow red>† THE CHOIR&apos;S CURRENCY</Eyebrow>
        </div>
        <Glitch size="clamp(48px, 11vw, 88px)" weight={400} style={{ letterSpacing: 0, lineHeight: 1 }}>
          {p.ticker}
        </Glitch>
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 16,
            lineHeight: 1.65,
            color: "var(--vc-bone-dim)",
            maxWidth: 560,
            marginTop: 24,
          }}
        >
          The relic was the first vow. {p.ticker} is the second. A curated{" "}
          {p.terms[3][0]} application opens on Avalanche — bearers of the relic are marked first,
          by on-chain snapshot, before the gate opens to the choir. The chain remembers who answered early.
        </p>

        {/* Key terms */}
        <div style={{ display: "flex", gap: 32, marginTop: 40, flexWrap: "wrap" }}>
          {p.terms.map(([v, k]) => (
            <div key={k} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 22, color: "var(--vc-bone)", letterSpacing: "0.02em" }}>{v}</span>
              <Eyebrow>{k}</Eyebrow>
            </div>
          ))}
        </div>

        {/* Allocation + tiers */}
        <div className="vc-grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 48, marginTop: 56 }}>
          <div>
            <Eyebrow red>SUPPLY · THE LEDGER</Eyebrow>
            <div style={{ marginTop: 18, display: "flex", flexDirection: "column" }}>
              {p.allocation.map(([pct, label], i) => (
                <div
                  key={label}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    padding: "12px 0",
                    borderTop: i === 0 ? "none" : "1px solid var(--vc-ash)",
                  }}
                >
                  <span style={{ fontFamily: "var(--font-body)", fontWeight: 500, fontSize: 14, color: "var(--vc-bone-dim)", letterSpacing: "0.04em" }}>{label}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 18, color: "var(--vc-bone)" }}>{pct}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <Eyebrow red>THE GATE · WHO IS MARKED</Eyebrow>
            <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 14 }}>
              {p.tiers.map(([num, name, desc]) => (
                <div key={num} style={{ display: "flex", gap: 16, padding: "14px 16px", background: "var(--vc-abyss)", border: "1px solid var(--vc-ash)", borderLeft: "2px solid var(--vc-crimson)" }}>
                  <span style={{ fontFamily: "var(--font-display)", fontWeight: 400, fontSize: 28, lineHeight: 1, color: "var(--vc-crimson)", minWidth: 28 }}>{num}</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontFamily: "var(--font-body)", fontWeight: 700, fontSize: 13, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--vc-bone)" }}>{name}</span>
                    <span style={{ fontFamily: "var(--font-body)", fontSize: 13, lineHeight: 1.5, color: "var(--vc-bone-dim)" }}>{desc}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* CTA — routes to Discord application */}
        <div style={{ marginTop: 56, display: "flex", flexDirection: "column", gap: 14, alignItems: "flex-start" }}>
          <Btn onClick={() => window.open(DISCORD, "_blank", "noopener")}>APPLY TO THE COVENANT →</Btn>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.06em", color: "var(--vc-bone-dim)", margin: 0, maxWidth: 480, lineHeight: 1.6 }}>
            Applications are taken in the choir. Bring your wallet and your mark — the curated window
            opens to bearers first. Not financial advice; participation may be restricted by region.
          </p>
        </div>
      </div>
    </section>
  );
}
