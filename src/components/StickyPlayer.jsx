import { VC_DATA } from "../data.js";
import { useAudio, fmt } from "../lib/audio.js";
import { PlayerBtn, TrackArt } from "./Atoms.jsx";
import { Play, Pause, SkipBack, SkipForward } from "lucide-react";

// ---------------- Bottom audio bar (sticky) ----------------
export function StickyPlayer() {
  const audio = useAudio();
  const queue = audio.queue || VC_DATA.tracklist;
  const cur = queue[audio.idx] || queue[0];
  const dur = audio.el?.duration || 0;
  const preview = audio.isPreview(cur);
  const t = audio.el?.currentTime || 0;
  const frac = dur ? t / dur : 0;
  // Pick eyebrow label from queueId
  const label = audio.queueId === "self-titled" ? "I · VOIDCALLER (EP)" : "II · TUNNEL VISION";
  const art = cur?.art || (audio.queueId === "self-titled" ? "/assets/voidcaller_art_4.png" : VC_DATA.featuredEP.art);
  const onSeek = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - rect.left) / rect.width;
    audio.seekFrac(f);
  };
  return (
    <div
      className="vc-sticky-player"
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 90,
        background: "rgba(10,10,11,0.92)",
        backdropFilter: "blur(14px)",
        borderTop: "1px solid var(--vc-ash)",
        padding: "12px clamp(14px, 4vw, 24px)",
        display: "flex",
        alignItems: "center",
        gap: 18,
      }}
    >
      <TrackArt art={art} vid={cur?.artVid} style={{ width: 44, height: 44, objectFit: "cover", filter: "contrast(1.1)", flexShrink: 0, display: "block" }} />
      <div className="vc-sticky-meta" style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--vc-crimson)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {label}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ fontFamily: "var(--font-body)", fontWeight: 700, fontSize: 13, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
            {cur.title}
          </span>
          {preview && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.16em", color: "var(--vc-crimson)", border: "1px solid var(--vc-crimson)", padding: "1px 5px", flexShrink: 0 }}>
              PREVIEW
            </span>
          )}
        </span>
      </div>
      <div
        className="vc-sticky-seek"
        onClick={onSeek}
        style={{ flex: 1, height: 4, background: "var(--vc-ash)", maxWidth: 260, marginLeft: 24, position: "relative", cursor: "pointer" }}
      >
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${frac * 100}%`, background: "var(--vc-crimson)", boxShadow: "0 0 12px var(--vc-crimson)" }} />
      </div>
      <span className="vc-sticky-time" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)" }}>{fmt(t)} / {preview && dur ? fmt(dur) : cur.time}</span>
      <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
        <PlayerBtn onClick={() => audio.prev()}><SkipBack size={20} strokeWidth={1.75} fill="currentColor" /></PlayerBtn>
        <PlayerBtn primary onClick={() => audio.toggle()}>
          {audio.playing
            ? <Pause size={20} strokeWidth={1.75} fill="currentColor" />
            : <Play size={20} strokeWidth={1.75} fill="currentColor" style={{ marginLeft: 2 }} />}
        </PlayerBtn>
        <PlayerBtn onClick={() => audio.next()}><SkipForward size={20} strokeWidth={1.75} fill="currentColor" /></PlayerBtn>
      </div>
    </div>
  );
}
