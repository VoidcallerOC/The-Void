import { useState } from "react";
import { VC_DATA } from "../data.js";
import { Eyebrow, Btn, Tag } from "./Atoms.jsx";
import { Glitch } from "./Overlays.jsx";
import { Play, Pause } from "lucide-react";
import { useAudio } from "../lib/audio.js";

// ---------------- Chronicle ----------------
export function Chronicle() {
  return (
    <section
      id="chronicle"
      style={{ position: "relative", padding: "clamp(96px, 13vw, 128px) clamp(20px, 6vw, 64px)", borderTop: "1px solid var(--vc-ash)" }}
    >
      <div className="vc-section-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 48 }}>
        <div>
          <Eyebrow red>THE CHRONICLE</Eyebrow>
          <div style={{ marginTop: 12 }}>
            <Glitch size="clamp(48px, 11vw, 88px)" weight={400} style={{ letterSpacing: 0, lineHeight: 1 }}>RELEASES</Glitch>
          </div>
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, letterSpacing: "0.12em", color: "var(--vc-bone-dim)", textTransform: "uppercase" }}>
          THREE CHAPTERS · ONE BLEED
        </div>
      </div>

      <div className="vc-grid-2col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, maxWidth: 960 }}>
        {VC_DATA.releases.map((r) => (
          <ReleaseCard key={r.id} r={r} />
        ))}
      </div>
    </section>
  );
}

function ReleaseCard({ r }) {
  const live = r.status === "LIVE" || r.live;
  const minted = r.status === "MINTED";
  const forthcoming = r.status === "FORTHCOMING";
  const [expanded, setExpanded] = useState(false);
  const audio = useAudio();
  const tracks = r.tracksKey ? VC_DATA[r.tracksKey] : null;
  const isThisQueue = audio.queueId === r.queueId;

  const playEP = () => {
    if (!tracks) return;
    if (!isThisQueue) {
      audio.setQueue(tracks, r.queueId);
    }
    audio.play(isThisQueue ? audio.idx : 0);
    setExpanded(true);
  };

  return (
    <div
      style={{
        background: "var(--vc-abyss)",
        border: "1px solid var(--vc-ash)",
        borderLeft: live ? "2px solid var(--vc-crimson)" : "1px solid var(--vc-ash)",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div style={{ aspectRatio: "1.4 / 1", position: "relative", overflow: "hidden" }}>
        <img
          src={r.art}
          alt=""
          loading="lazy"
          decoding="async"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            filter: forthcoming ? "grayscale(0.4) contrast(1.05) brightness(0.6)" : "contrast(1.08)",
            opacity: forthcoming ? 0.6 : 1,
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg, transparent 60%, rgba(0,0,0,0.9) 100%)",
          }}
        />
        <div style={{ position: "absolute", top: 14, left: 14, display: "flex", gap: 6 }}>
          {minted && <Tag kind="crimson" pulse>TRADING NOW</Tag>}
          {forthcoming && <Tag kind="outline">{r.status}</Tag>}
        </div>
      </div>
      <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
        <Eyebrow red={live}>
          CHAPTER {r.id} · {r.subtitle}
        </Eyebrow>
        <div style={{ marginTop: 4 }}>
          <Glitch size="clamp(32px, 8vw, 44px)" weight={400} style={{ letterSpacing: 0, lineHeight: 1 }}>{r.title}</Glitch>
        </div>
        <p style={{ margin: 0, fontFamily: "var(--font-body)", fontSize: 14, color: "var(--vc-bone-dim)", lineHeight: 1.5 }}>
          {r.tagline}
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
            paddingTop: 14,
            marginTop: 4,
            borderTop: "1px solid var(--vc-ash)",
          }}
        >
          <Meta k="CHAIN" v={minted ? "AVALANCHE" : "—"} />
          <Meta k="STATUS" v={r.status} />
        </div>
        {minted ? (
          <>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              {tracks && (
                <Btn
                  kind="primary"
                  onClick={playEP}
                  style={{ flex: 1.4, padding: "12px 8px", fontSize: 10, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}
                >
                  {isThisQueue && audio.playing
                    ? <><Pause size={12} strokeWidth={1.75} fill="currentColor" /> PLAYING</>
                    : <><Play size={12} strokeWidth={1.75} fill="currentColor" /> LISTEN</>}
                </Btn>
              )}
              {VC_DATA.marketplaces.filter(m => m.name !== "SNOWTRACE").map((m) => (
                <Btn
                  key={m.name}
                  kind="ghost"
                  onClick={() => window.open(m.href, "_blank")}
                  style={{ flex: 1, padding: "12px 8px", fontSize: 10 }}
                >
                  {m.name}
                </Btn>
              ))}
            </div>
            {expanded && tracks && (
              <InlineTracklist tracks={tracks} audio={audio} queueId={r.queueId} />
            )}
          </>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
            <Btn
              kind="primary"
              onClick={() => window.open(VC_DATA.socials.find((s) => s.name === "Discord").href, "_blank", "noopener")}
            >
              ANSWER THE CALL →
            </Btn>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.14em", color: "var(--vc-bone-dim)", textTransform: "uppercase" }}>
              Forthcoming · bearers marked first
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Meta({ k, v }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.16em", color: "var(--vc-bone-dim)", textTransform: "uppercase" }}>
        {k}
      </span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 16, color: "var(--vc-bone)" }}>{v}</span>
    </div>
  );
}

// Inline tracklist that renders inside a Release card when LISTEN is clicked
function InlineTracklist({ tracks, audio, queueId }) {
  const isThisQueue = audio.queueId === queueId;
  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--vc-ash)", display: "flex", flexDirection: "column", gap: 0 }}>
      {tracks.map((t, i) => {
        const active = isThisQueue && i === audio.idx;
        return (
          <div
            key={t.n}
            onClick={() => { audio.setQueue(tracks, queueId); audio.play(i); }}
            style={{
              display: "grid",
              gridTemplateColumns: "26px 1fr auto",
              gap: 10,
              padding: "8px 10px",
              cursor: "pointer",
              background: active ? "rgba(225,15,31,0.08)" : "transparent",
              borderLeft: active ? "2px solid var(--vc-crimson)" : "2px solid transparent",
              transition: "all 120ms",
            }}
            onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
            onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ display: "flex", alignItems: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: active ? "var(--vc-crimson)" : "var(--vc-bone-dim)", letterSpacing: "0.06em" }}>
              {active && audio.playing ? <Play size={10} strokeWidth={1.75} fill="currentColor" /> : t.n}
            </span>
            <span style={{ fontFamily: "var(--font-body)", fontWeight: active ? 700 : 500, fontSize: 13, color: active ? "var(--vc-bone)" : "var(--vc-bone-dim)" }}>
              {t.title}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--vc-bone-dim)" }}>{t.time}</span>
          </div>
        );
      })}
    </div>
  );
}
