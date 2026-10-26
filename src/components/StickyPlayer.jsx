import { VC_DATA } from "../data.js";
import { useState } from "react";
import { useAudio, fmt } from "../lib/audio.js";
import { PlayerBtn, TrackArt } from "./Atoms.jsx";
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";

function Mark({ children, on }) {
  return (
    <span style={{
      fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 500, lineHeight: 1, letterSpacing: "0.14em",
      color: on ? "#fff" : "var(--vc-crimson)",
      background: on ? "var(--vc-blood)" : "transparent",
      border: `1px solid ${on ? "var(--vc-blood)" : "var(--vc-crimson)"}`,
      padding: "4px 8px", flexShrink: 0,
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

async function copyText(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* Fall back to a hidden textarea below. */ }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand?.("copy") ?? false;
    document.body.removeChild(area);
    return Boolean(ok);
  } catch {
    return false;
  }
}

// Opt-in (?audioDebug=1) panel. Shows only the sanitized event ring from audio.js.
function AudioDebugPanel({ audio }) {
  const [copied, setCopied] = useState("");
  const events = audio.diagnostics.events;
  const onCopy = async () => setCopied((await copyText(audio.diagnosticsText())) ? "Copied" : "Copy failed");
  return (
    <section aria-label="Audio diagnostics" className="vc-audio-debug" style={{ position: "fixed", bottom: 96, right: 12, zIndex: 91, width: "min(420px, calc(100vw - 24px))", maxHeight: "40vh", overflow: "auto", background: "rgba(6,6,7,0.97)", border: "1px solid var(--vc-ash)", padding: 10, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <strong style={{ color: "var(--vc-bone)" }}>Audio diagnostics ({events.length})</strong>
        <button type="button" onClick={onCopy} style={{ marginLeft: "auto" }}>Copy diagnostics</button>
        {copied && <span role="status">{copied}</span>}
      </div>
      <ol style={{ margin: 0, paddingLeft: 18 }}>
        {events.slice(-30).map((event, i) => (
          <li key={`${event.t}-${i}`}>{[event.type, event.category, event.host, event.reused != null ? (event.reused ? "reused" : "reset") : null, event.code != null ? `code=${event.code}` : null, event.name, `net=${event.networkState ?? "-"}`, `ready=${event.readyState ?? "-"}`].filter(Boolean).join(" ")}</li>
        ))}
      </ol>
    </section>
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
  // A bearer stream of an experience with its own audio (a demo attached to a
  // token) is named after that experience, not the token's song.
  const title = bearer && cur?.protectedTitle ? cur.protectedTitle : cur.title;
  const needsGesture = Boolean(audio.needsGesture);
  const playbackError = audio.lastError && audio.lastError.track === cur && audio.lastError.kind !== "gesture" ? audio.lastError.message : "";
  const t = audio.el?.currentTime || 0;
  const total = dur ? fmt(dur) : cur.time;
  const frac = dur ? t / dur : 0;
  // Pick eyebrow label from queueId
  const label = audio.queueLabel || (audio.queueId === "self-titled" ? "I · VOIDCALLER (EP)" : "II · TUNNEL VISION");
  const art = cur?.art || (audio.queueId === "self-titled" ? "/assets/voidcaller_ep_cover.webp" : VC_DATA.featuredEP.art);
  const seekMax = 1000;
  const seekValue = Math.round(Math.max(0, Math.min(1, frac)) * seekMax);
  const seekValueText = `${fmt(t)} of ${total}`;
  const onSeekInput = (e) => {
    audio.seekFrac(Number(e.target.value) / seekMax);
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
        background: "rgba(6,6,7,0.97)",
        backdropFilter: "blur(14px)",
        borderTop: "1px solid var(--vc-ash)",
        padding: "12px clamp(14px, 4vw, 24px)",
        display: "flex",
        alignItems: "center",
        gap: 18,
      }}
    >
      <TrackArt art={art} vid={cur?.artVid} style={{ width: 64, height: 64, objectFit: "cover", filter: "contrast(1.1)", flexShrink: 0, display: "block" }} />
      <div className="vc-sticky-meta" style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: "0 1 440px" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--vc-ember)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {label}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 400, fontSize: "clamp(20px, 2.2vw, 26px)", lineHeight: 1.05, color: "var(--vc-bone)", textTransform: "uppercase", letterSpacing: "0.03em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
            {title}
          </span>
          {preview && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 500, letterSpacing: "0.14em", lineHeight: 1, color: "var(--vc-bone)", background: "rgba(184,7,16,0.35)", border: "1px solid var(--vc-crimson)", padding: "4px 8px", flexShrink: 0 }}>
              PREVIEW
            </span>
          )}
          {bearer && <Mark on>BEARER</Mark>}
        </span>
        {needsGesture && <button type="button" className="vc-sticky-tap-to-play" data-state="tap-to-play" onClick={() => audio.play().catch(() => {})} style={{ alignSelf: "flex-start", fontFamily: "var(--font-mono)", fontSize: 12, letterSpacing: "0.08em", color: "var(--vc-bone)", background: "var(--vc-blood)", border: "1px solid var(--vc-crimson)", padding: "4px 8px", cursor: "pointer" }}>Tap to play</button>}
        {playbackError && <span role="status" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--vc-ember)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{playbackError}</span>}
      </div>
      <div
        className="vc-sticky-seek"
        style={{ flex: 1, height: 16, maxWidth: 260, marginLeft: 24, position: "relative", display: "flex", alignItems: "center" }}
      >
        <div
          aria-hidden="true"
          style={{ position: "absolute", left: 0, right: 0, height: 4, background: "var(--vc-ash)", pointerEvents: "none" }}
        >
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${frac * 100}%`, background: "var(--vc-crimson)" }} />
        </div>
        <input
          type="range"
          className="vc-sticky-seek-input"
          min={0}
          max={seekMax}
          step={1}
          value={seekValue}
          aria-label="Seek"
          aria-valuetext={seekValueText}
          disabled={!dur}
          onChange={onSeekInput}
        />
      </div>
      <span className="vc-sticky-time" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--vc-bone-dim)", fontVariantNumeric: "tabular-nums" }}>{fmt(t)} / {total}</span>
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
      {audio.diagnostics.enabled && <AudioDebugPanel audio={audio} />}
    </div>
  );
}
