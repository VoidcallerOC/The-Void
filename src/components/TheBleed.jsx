import { useEffect } from "react";
import { VC_DATA } from "../data.js";
import { Eyebrow, Btn, TrackArt, PlayerBtn } from "./Atoms.jsx";
import { Glitch } from "./Overlays.jsx";
import { Play, Pause, SkipBack, SkipForward } from "lucide-react";

const DISCORD = VC_DATA.socials.find((s) => s.name === "Discord").href;
import { useAudio, fmt } from "../lib/audio.js";

// ---------------- The Bleed (player + tracklist) ----------------
export function TheBleed() {
  const audio = useAudio();
  // Ensure The Bleed section uses the Tunnel Vision queue when first viewed.
  // `audio` is a stable module singleton, so this effectively runs once.
  useEffect(() => {
    if (audio.queueId !== "tunnel-vision") {
      // user explicitly chose another queue elsewhere; don't override
    } else if (!audio.queue) {
      audio.setQueue(VC_DATA.tracklist, "tunnel-vision");
    }
  }, [audio]);
  const queue = audio.queue || VC_DATA.tracklist;
  const idx = audio.idx;
  const cur = queue[idx] || queue[0];
  const dur = audio.el?.duration || 0;
  const t = audio.el?.currentTime || 0;
  const frac = dur ? t / dur : 0;
  const featured = VC_DATA.featuredEP;
  const fragment = audio.isPreview(cur);
  const onSeek = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - rect.left) / rect.width;
    audio.seekFrac(f);
  };

  return (
    <section
      id="the-bleed"
      style={{
        position: "relative",
        padding: "clamp(96px, 13vw, 128px) clamp(20px, 6vw, 64px)",
        borderTop: "1px solid var(--vc-ash)",
        background:
          "linear-gradient(180deg, var(--vc-void) 0%, var(--vc-pit) 100%)",
      }}
    >
      <div className="vc-grid-2col" style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 64 }}>
        <div>
          <Eyebrow red>{featured.subtitle.toUpperCase()}</Eyebrow>
          <div style={{ marginTop: 12 }}>
            <Glitch size="clamp(48px, 11vw, 88px)" weight={400} style={{ letterSpacing: 0, lineHeight: 1 }}>{featured.title}</Glitch>
          </div>
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 400,
              fontSize: "clamp(18px, 3vw, 22px)",
              textTransform: "uppercase",
              letterSpacing: "0",
              color: "var(--vc-bone-dim)",
              marginTop: 24,
            }}
          >
            "{featured.pullquote}"
          </div>
          <p
            style={{
              fontFamily: "var(--font-body)",
              fontSize: 16,
              lineHeight: 1.65,
              color: "var(--vc-bone-dim)",
              maxWidth: 480,
              marginTop: 32,
            }}
          >
            {featured.body}
          </p>
          <div style={{ marginTop: 32 }}>
            <Btn onClick={() => window.open(DISCORD, "_blank", "noopener")}>ANSWER THE CALL →</Btn>
            <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.06em", color: "var(--vc-bone-dim)", marginTop: 12, marginBottom: 0 }}>
              Thirty seconds for the world. The rest for the bearer.
            </p>
          </div>
        </div>

        <div
          style={{
            background: "var(--vc-abyss)",
            border: "1px solid var(--vc-ash)",
            padding: 24,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
            <TrackArt
              art={cur.art || featured.art}
              vid={cur.artVid}
              style={{ width: 84, height: 84, objectFit: "cover", filter: "contrast(1.05)", transition: "opacity 220ms", display: "block" }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 }}>
              <Eyebrow red>NOW BLEEDING · {cur.n}{fragment ? " · FRAGMENT" : ""}</Eyebrow>
              <div style={{ marginTop: 2 }}>
                <span style={{
                  display: "inline-block",
                  fontFamily: "var(--font-display)",
                  fontWeight: 400,
                  fontSize: "clamp(20px, 5vw, 28px)",
                  lineHeight: 1,
                  letterSpacing: "0",
                  textTransform: "uppercase",
                }}>{cur.title}</span>
              </div>
              {VC_DATA.lyrics?.[cur.n] && (
                <div style={{ fontFamily: "var(--font-display)", fontSize: 15, lineHeight: 1.3, color: "var(--vc-bone-dim)", marginTop: 8 }}>
                  "{VC_DATA.lyrics[cur.n]}"
                </div>
              )}
            </div>
          </div>

          <div
            onClick={onSeek}
            style={{
              height: 6,
              background: "var(--vc-ash)",
              position: "relative",
              marginBottom: 8,
              cursor: "pointer",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: `${frac * 100}%`,
                background: "var(--vc-crimson)",
                boxShadow: "0 0 12px var(--vc-crimson)",
              }}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)", marginBottom: 16 }}>
            <span>{fmt(t)}</span>
            <span>{fragment && dur ? fmt(dur) : cur.time}</span>
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 24 }}>
            <PlayerBtn onClick={() => audio.prev()}><SkipBack size={20} strokeWidth={1.75} fill="currentColor" /></PlayerBtn>
            <PlayerBtn primary onClick={() => audio.toggle()}>
              {audio.playing
                ? <Pause size={20} strokeWidth={1.75} fill="currentColor" />
                : <Play size={20} strokeWidth={1.75} fill="currentColor" style={{ marginLeft: 2 }} />}
            </PlayerBtn>
            <PlayerBtn onClick={() => audio.next()}><SkipForward size={20} strokeWidth={1.75} fill="currentColor" /></PlayerBtn>
          </div>

          {/* Tracklist */}
          <div style={{ display: "flex", flexDirection: "column", gap: 0, marginTop: 8 }}>
            {queue.map((trk, i) => {
              const active = i === idx;
              const gated = audio.isPreview(trk);
              return (
                <div
                  key={trk.n}
                  onClick={() => audio.play(i)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "32px 1fr auto",
                    gap: 14,
                    padding: "12px 12px",
                    cursor: "pointer",
                    background: active ? "rgba(225,15,31,0.06)" : "transparent",
                    borderLeft: active ? "2px solid var(--vc-crimson)" : "2px solid transparent",
                    transition: "all 120ms",
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = "rgba(255,255,255,0.02)";
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = "transparent";
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", fontFamily: "var(--font-mono)", fontSize: 11, color: active ? "var(--vc-crimson)" : "var(--vc-bone-dim)", letterSpacing: "0.06em" }}>
                    {active && audio.playing ? <Play size={11} strokeWidth={1.75} fill="currentColor" /> : trk.n}
                  </span>
                  <span style={{ fontFamily: "var(--font-body)", fontWeight: active ? 700 : 500, fontSize: 14, color: active ? "var(--vc-bone)" : "var(--vc-bone-dim)" }}>
                    {trk.title}
                    {gated && <span style={{ marginLeft: 8, fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.14em", color: "var(--vc-crimson)" }}>FRAGMENT</span>}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)" }}>
                    {trk.time}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* What the relic unlocks */}
      <div style={{ marginTop: "clamp(56px, 9vw, 96px)" }}>
        <Eyebrow red>WHAT THE RELIC UNLOCKS</Eyebrow>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, marginTop: 24 }}>
          {VC_DATA.unlocks.map(([title, desc]) => (
            <div
              key={title}
              style={{
                flex: 1,
                minWidth: 240,
                background: "var(--vc-abyss)",
                border: "1px solid var(--vc-ash)",
                borderLeft: "2px solid var(--vc-crimson)",
                padding: "24px 26px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 400, fontSize: 26, lineHeight: 1, letterSpacing: 0, textTransform: "uppercase", color: "var(--vc-bone)" }}>{title}</span>
              <p style={{ margin: 0, fontFamily: "var(--font-body)", fontSize: 14, lineHeight: 1.6, color: "var(--vc-bone-dim)" }}>{desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
