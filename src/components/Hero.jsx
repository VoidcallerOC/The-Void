import { VC_DATA } from "../data.js";
import { Eyebrow, Btn, Tag } from "./Atoms.jsx";
import { WordmarkGlitch } from "./Overlays.jsx";
import { useAudio } from "../lib/audio.js";

// ---------------- Hero ----------------
export function Hero({ onMint }) {
  const audio = useAudio();
  const hearEP = () => {
    audio.setQueue(VC_DATA.firstEPTracks, "self-titled");
    audio.play(0);
  };

  return (
    <section
      id="top"
      className="vc-hero"
      style={{
        position: "relative",
        minHeight: "100vh",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        padding: "0 clamp(20px, 6vw, 64px)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: "url('/assets/voidcaller_art_4.png')",
          backgroundSize: "cover",
          backgroundPosition: "center 35%",
          transform: "scale(1.18)",
          transformOrigin: "center",
          filter: "contrast(1.06) saturate(0.95)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.45) 40%, rgba(0,0,0,0.85) 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 90% 80% at 50% 42%, transparent 35%, rgba(0,0,0,0.55) 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: 2,
          background:
            "linear-gradient(180deg, transparent 0%, transparent 20%, #B80710 50%, transparent 100%)",
          opacity: 0.7,
          animation: "vc-bleed 6s ease-in-out infinite",
        }}
      />
      <div style={{ position: "relative", zIndex: 2, maxWidth: 1100, display: "flex", flexDirection: "column", gap: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Tag kind="crimson" pulse>LIVE · ON AVALANCHE</Tag>
          <Eyebrow>CHAPTER I · SELF-TITLED EP</Eyebrow>
        </div>
        <WordmarkGlitch />
        <div style={{ marginTop: -8 }}>
          <span style={{
            display: "inline-block",
            fontFamily: "var(--font-display)",
            fontWeight: 400,
            fontSize: "clamp(28px, 6vw, 42px)",
            lineHeight: 1,
            letterSpacing: "0",
            textTransform: "uppercase",
          }}>Four tracks · one relic · forged on Avalanche</span>
        </div>
        <p
          style={{
            fontFamily: "var(--font-body)",
            fontSize: 18,
            lineHeight: 1.55,
            color: "var(--vc-bone-dim)",
            maxWidth: 580,
            margin: 0,
          }}
        >
          The first call. The first relic. Trading now on OpenSea and Joepegs — the chain remembers.
        </p>
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            letterSpacing: "0.08em",
            lineHeight: 1.6,
            color: "var(--vc-bone-dim)",
            maxWidth: 560,
            margin: 0,
            textTransform: "uppercase",
          }}
        >
          One Chapter I relic unlocks the entire EP. Without it you hear fragments.
        </p>
        <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
          <Btn onClick={onMint}>Claim the relic</Btn>
          <Btn kind="ghost" onClick={hearEP}>Hear the EP</Btn>
        </div>
        <div style={{ display: "flex", gap: 32, marginTop: 32, flexWrap: "wrap" }}>
          {VC_DATA.heroStats.map(([v, k]) => (
            <div key={k} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 16, color: "var(--vc-bone)", letterSpacing: "0.04em" }}>{v}</span>
              <Eyebrow>{k}</Eyebrow>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
