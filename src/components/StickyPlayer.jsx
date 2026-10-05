import { VC_DATA } from "../data.js";
import { useAudio, fmt } from "../lib/audio.js";
import { PlayerBtn, TrackArt } from "./Atoms.jsx";
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";

function Mark({ children, on }) {
  return (
    <span style={{
      fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.16em",
      color: on ? "#fff" : "var(--vc-crimson)",
      background: on ? "var(--vc-blood)" : "transparent",
      border: `1px solid ${on ? "var(--vc-blood)" : "var(--vc-crimson)"}`,
      padding: "1px 5px", flexShrink: 0,
    }}>
      {children}
    </span>
  );
}

function MasterVolume({ audio }) {
  const value = audio.masterVolumePercent();
  const Icon = value === 0 ? VolumeX : Volume2;
  return (
    <label className="vc-sticky-volume" style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-label="Master volume"
        aria-valuetext={`${value} percent`}
        onChange={(e) => audio.setMasterVolumePercent(e.target.value)}
      />
      <span aria-hidden="true" style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.08em", color: "var(--vc-bone-dim)", minWidth: 32, textAlign: "right" }}>
        {value}%
      </span>
    </label>
  );
}

// ---------------- Bottom audio bar (sticky) ----------------
export function StickyPlayer() {
  const audio = useAudio();
  const queue = audio.queue || VC_DATA.tracklist;
  const cur = queue[audio.idx] || queue[0];
  const dur = audio.el?.duration || 0;
  const preview = audio.isPreview(cur);
  const bearer = audio.isBearer(cur);
  const t = audio.el?.currentTime || 0;
  const total = dur ? fmt(dur) : cur.time;
  const frac = dur ? t / dur : 0;
  // Pick eyebrow label from queueId
  const label = audio.queueLabel || (audio.queueId === "self-titled" ? "I · VOIDCALLER (EP)" : "II · TUNNEL VISION");
  const art = cur?.art || (audio.queueId === "self-titled" ? "/assets/voidcaller_ep_cover.webp" : VC_DATA.featuredEP.art);
  const onSeek = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - rect.left) / rect.width;
    audio.seekFrac(f);
  };
  return (
    <div
      className="vc-sticky-player vc-player-needle"
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
      <TrackArt art={art} vid={cur?.artVid} style={{ width: 56, height: 56, objectFit: "cover", filter: "contrast(1.1)", flexShrink: 0, display: "block" }} />
      <div className="vc-sticky-meta" style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--vc-crimson)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {label}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 400, fontSize: 18, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
            {cur.title}
          </span>
          {preview && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.16em", color: "var(--vc-crimson)", border: "1px solid var(--vc-crimson)", padding: "1px 5px", flexShrink: 0 }}>
              PREVIEW
            </span>
          )}
          {bearer && <Mark on>BEARER</Mark>}
        </span>
      </div>
      <div
        className="vc-sticky-seek"
        onClick={onSeek}
        style={{ flex: 1, height: 4, background: "var(--vc-ash)", maxWidth: 260, marginLeft: 24, position: "relative", cursor: "pointer" }}
      >
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${frac * 100}%`, background: "var(--vc-crimson)", boxShadow: "none" }} />
      </div>
      <span className="vc-sticky-time" style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)" }}>{fmt(t)} / {total}</span>
      <div className="vc-sticky-controls" style={{ display: "flex", alignItems: "center", gap: 14, marginLeft: "auto", flexShrink: 0 }}>
        <MasterVolume audio={audio} />
        <div style={{ display: "flex", gap: 6 }}>
          <PlayerBtn label="Previous track" onClick={() => audio.prev()}><SkipBack size={20} strokeWidth={1.75} fill="currentColor" /></PlayerBtn>
          <PlayerBtn primary label={audio.playing ? "Pause" : "Play"} onClick={() => audio.toggle()}>
            {audio.playing
              ? <Pause size={20} strokeWidth={1.75} fill="currentColor" />
              : <Play size={20} strokeWidth={1.75} fill="currentColor" style={{ marginLeft: 2 }} />}
          </PlayerBtn>
          <PlayerBtn label="Next track" onClick={() => audio.next()}><SkipForward size={20} strokeWidth={1.75} fill="currentColor" /></PlayerBtn>
        </div>
      </div>
    </div>
  );
}
