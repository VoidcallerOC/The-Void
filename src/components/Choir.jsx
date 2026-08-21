import { VC_DATA } from "../data.js";
import { Eyebrow, Btn } from "./Atoms.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { useWallet } from "../lib/WalletContext.jsx";

const DISCORD = VC_DATA.socials.find((s) => s.name === "Discord").href;

// ---------------- Manifesto / Choir ----------------
export function Choir() {
  const w = useWallet();
  const marks = w.identity?.marks || [];

  return (
    <section
      id="choir"
      style={{
        position: "relative",
        padding: "clamp(96px, 13vw, 128px) clamp(20px, 6vw, 64px)",
        borderTop: "1px solid var(--vc-ash)",
        textAlign: "center",
      }}
    >
      <Eyebrow red style={{ textAlign: "center" }}>
        † THE MANIFESTO †
      </Eyebrow>
      <div
        style={{
          maxWidth: 980,
          margin: "32px auto 0",
          display: "flex",
          flexDirection: "column",
          gap: 24,
          alignItems: "center",
        }}
      >
        {VC_DATA.manifesto.map((line, i) => (
          <div
            key={i}
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 400,
              fontSize: "clamp(28px, 3.4vw, 44px)",
              lineHeight: 1.15,
              letterSpacing: "0",
              textTransform: "uppercase",
              color: "var(--vc-bone)",
              textAlign: "center",
            }}
          >
            {line}
          </div>
        ))}
      </div>

      {/* The gathering — community proof + join */}
      <div
        style={{
          maxWidth: 760,
          margin: "clamp(56px, 9vw, 96px) auto 0",
          paddingTop: "clamp(40px, 6vw, 64px)",
          borderTop: "1px solid var(--vc-ash)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 28,
        }}
      >
        <Eyebrow>† THE GATHERING</Eyebrow>
        <div style={{ display: "flex", gap: "clamp(32px, 8vw, 64px)", flexWrap: "wrap", justifyContent: "center" }}>
          {VC_DATA.heroStats.slice(0, 2).map(([v, k]) => (
            <div key={k} style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "clamp(28px, 5vw, 40px)", color: "var(--vc-bone)", letterSpacing: "0.02em" }}>{v}</span>
              <Eyebrow>{k}</Eyebrow>
            </div>
          ))}
        </div>

        {w.connected ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
            <p style={{ fontFamily: "var(--font-body)", fontSize: 16, lineHeight: 1.65, color: "var(--vc-bone-dim)", maxWidth: 520, margin: 0 }}>
              {marks.length
                ? "The chain knows you."
                : "Connected. No relic on this wallet — the fragment is all that plays."}
            </p>
            {marks.length > 0 && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                {marks.map((m) => (
                  <span key={m} style={{
                    fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.16em",
                    color: "#fff", background: "var(--vc-blood)", padding: "6px 10px",
                  }}>{m}</span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p style={{ fontFamily: "var(--font-body)", fontSize: 16, lineHeight: 1.65, color: "var(--vc-bone-dim)", maxWidth: 520, margin: 0 }}>
            The choir is not an audience. It is the record of everyone who answered the call —
            written on-chain, carried forward into the next bleed.
          </p>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
          <WalletButton />
          <Btn onClick={() => window.open(DISCORD, "_blank", "noopener")}>ANSWER THE CALL →</Btn>
          <div style={{ display: "flex", gap: 18 }}>
            {VC_DATA.socials.map((s) => (
              <a
                key={s.name}
                href={s.href}
                target="_blank"
                rel="noopener noreferrer"
                className="vc-navlink"
                style={{ fontSize: 12 }}
              >
                {s.name.toUpperCase()}
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
