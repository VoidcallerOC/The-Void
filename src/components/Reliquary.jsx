import { useEffect, useState } from "react";
import { Send, Play, Pause } from "lucide-react";
import { Eyebrow, Btn } from "./Atoms.jsx";
import { Glitch } from "./Overlays.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { TransferModal } from "./TransferModal.jsx";
import { useWallet } from "../lib/WalletContext.jsx";
import { fetchAllMetadata, ipfsToHttp, CHAINS, FALLBACK_METADATA } from "../lib/web3.js";
import { useAudio } from "../lib/audio.js";
import { VC_DATA } from "../data.js";

// Released-EP tracks are keyed to relic token ids — map a relic to its track.
const trackIndexForToken = (tokenId) =>
  VC_DATA.firstEPTracks.findIndex((t) => t.tokenId === tokenId);

const TABS = [["cchain", "C-CHAIN"], ["grotto", "THE GROTTO"]];

export function Reliquary() {
  const w = useWallet();
  const audio = useAudio();
  const [meta, setMeta] = useState(FALLBACK_METADATA);
  const [tab, setTab] = useState("cchain");
  const [transfer, setTransfer] = useState(null); // { relic, chainKey }
  const marks = w.identity?.marks || [];

  // Play (or toggle) the released track tied to this relic.
  // Any Chapter I relic unlocks the full EP in the player.
  const playRelic = (tokenId) => {
    const idx = trackIndexForToken(tokenId);
    if (idx < 0) return;
    const onThis = audio.queueId === "self-titled" && audio.idx === idx;
    if (onThis) { audio.toggle(); return; }
    if (audio.queueId !== "self-titled") audio.setQueue(VC_DATA.firstEPTracks, "self-titled");
    audio.play(idx);
  };
  const isPlayingRelic = (tokenId) =>
    audio.queueId === "self-titled" && audio.idx === trackIndexForToken(tokenId) && audio.playing;

  useEffect(() => {
    let alive = true;
    fetchAllMetadata().then((m) => { if (alive) setMeta(m); });
    return () => { alive = false; };
  }, []);

  const ownedSet = w.owned[tab] || new Set();
  const ownedCount = (w.owned.cchain?.size || 0) + (w.owned.grotto?.size || 0);
  const canHearEP = !!w.identity?.witness;

  return (
    <section style={{ maxWidth: 1100, margin: "0 auto", padding: "clamp(96px, 14vw, 160px) clamp(20px, 5vw, 48px) clamp(120px, 16vw, 200px)" }}>
      <div className="vc-section-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 24, marginBottom: "clamp(32px, 6vw, 56px)" }}>
        <div>
          <Eyebrow red>† THE RELIQUARY</Eyebrow>
          <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(48px, 9vw, 92px)", textTransform: "uppercase", lineHeight: 0.92, margin: "16px 0 0" }}>
            <Glitch size="clamp(48px, 9vw, 92px)" weight={400} style={{ letterSpacing: 0, lineHeight: 0.92 }}>YOUR RELICS</Glitch>
          </h1>
          <p style={{ fontFamily: "var(--font-body)", fontSize: 15, color: "var(--vc-bone-dim)", maxWidth: 440, marginTop: 18, lineHeight: 1.6 }}>
            Every relic is read straight from the chain. One Chapter I relic unlocks the full EP. Own the relic, own the song.
          </p>
          {w.connected && marks.length > 0 && (
            <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
              {marks.map((m) => (
                <span key={m} style={{
                  fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.16em",
                  color: "#fff", background: "var(--vc-blood)", padding: "4px 8px",
                }}>{m}</span>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
          <WalletButton />
          {w.connected && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vc-bone-dim)" }}>
              {w.loadingOwnership ? "READING THE CHAIN…" : `${ownedCount} RELIC${ownedCount === 1 ? "" : "S"} BORNE`}
            </span>
          )}
          {canHearEP && (
            <Btn kind="ghost" onClick={() => { audio.setQueue(VC_DATA.firstEPTracks, "self-titled"); audio.play(0); }}>
              HEAR THE EP
            </Btn>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--vc-ash)", marginBottom: "clamp(28px, 5vw, 44px)" }}>
        {TABS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              fontFamily: "var(--font-mono)", fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase",
              padding: "12px 20px", background: "transparent", border: "none", cursor: "pointer",
              color: tab === key ? "var(--vc-bone)" : "var(--vc-bone-dim)",
              borderBottom: tab === key ? "2px solid var(--vc-crimson)" : "2px solid transparent",
              marginBottom: -1, transition: "color 120ms",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "clamp(16px, 2.5vw, 24px)" }}>
        {meta.map((relic) => {
          const owned = w.connected && ownedSet.has(relic.tokenId);
          const playable = canHearEP && trackIndexForToken(relic.tokenId) >= 0;
          const playing = playable && isPlayingRelic(relic.tokenId);
          return (
            <div
              key={relic.tokenId}
              style={{
                background: "var(--vc-abyss)", border: "1px solid var(--vc-ash)",
                borderTop: owned ? "2px solid var(--vc-crimson)" : "2px solid var(--vc-ash)",
                position: "relative", overflow: "hidden",
              }}
            >
              <div
                onClick={playable ? () => playRelic(relic.tokenId) : undefined}
                className={playable ? "vc-relic-art" : undefined}
                style={{ position: "relative", aspectRatio: "1 / 1", overflow: "hidden", cursor: playable ? "pointer" : "default" }}
              >
                <img
                  src={ipfsToHttp(relic.image)}
                  alt={relic.name}
                  loading="lazy"
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", filter: owned ? "none" : "grayscale(1) brightness(0.5)", transition: "filter 200ms" }}
                />
                <div style={{ position: "absolute", top: 10, left: 10, display: "flex", gap: 6 }}>
                  <span style={{
                    fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase",
                    padding: "4px 8px", background: owned ? "var(--vc-blood)" : "rgba(0,0,0,0.7)",
                    color: owned ? "#fff" : "var(--vc-bone-dim)", border: owned ? "none" : "1px solid var(--vc-ash)",
                  }}>
                    {owned ? "BORNE" : w.connected ? "NOT OWNED" : "LOCKED"}
                  </span>
                  {tab === "grotto" && owned && (
                    <span style={{
                      fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.16em", textTransform: "uppercase",
                      padding: "4px 8px", background: "transparent", color: "var(--vc-crimson)", border: "1px solid var(--vc-crimson)",
                    }}>CROSSED</span>
                  )}
                </div>
                {playable && (
                  <div
                    className="vc-relic-playbtn"
                    style={{
                      position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
                      background: playing ? "rgba(0,0,0,0.32)" : "rgba(0,0,0,0.5)",
                      opacity: playing ? 1 : 0, transition: "opacity 160ms",
                    }}
                  >
                    <span style={{
                      width: 52, height: 52, borderRadius: 999, display: "flex", alignItems: "center", justifyContent: "center",
                      background: "var(--vc-crimson)", color: "#fff", boxShadow: "0 0 28px -4px rgba(225,15,31,0.7)",
                    }}>
                      {playing
                        ? <Pause size={22} strokeWidth={1.75} fill="currentColor" />
                        : <Play size={22} strokeWidth={1.75} fill="currentColor" style={{ marginLeft: 3 }} />}
                    </span>
                  </div>
                )}
              </div>
              <div style={{ padding: "16px 18px 18px" }}>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 22, textTransform: "uppercase", lineHeight: 1 }}>{relic.name}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--vc-bone-dim)", marginTop: 8, display: "flex", justifyContent: "space-between" }}>
                  <span>TOKEN #{relic.tokenId}</span>
                  <span>{CHAINS[tab].short}</span>
                </div>
                {owned && (
                  <button
                    onClick={() => setTransfer({ relic, chainKey: tab })}
                    style={{
                      marginTop: 14, width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
                      fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase",
                      padding: "9px", background: "transparent", border: "1px solid var(--vc-ash)", color: "var(--vc-bone-dim)", cursor: "pointer",
                      transition: "all 120ms",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--vc-crimson)"; e.currentTarget.style.color = "var(--vc-bone)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--vc-ash)"; e.currentTarget.style.color = "var(--vc-bone-dim)"; }}
                  >
                    <Send size={12} strokeWidth={1.75} /> SEND
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!w.connected && (
        <div style={{ textAlign: "center", marginTop: "clamp(40px, 7vw, 72px)" }}>
          <p style={{ fontFamily: "var(--font-body)", fontSize: 15, color: "var(--vc-bone-dim)", marginBottom: 12, maxWidth: 440, marginLeft: "auto", marginRight: "auto" }}>
            The four Chapter I relics are shown locked until you connect. Any one of them unlocks the full EP.
          </p>
          <WalletButton />
        </div>
      )}

      <TransferModal
        open={!!transfer}
        relic={transfer?.relic}
        chainKey={transfer?.chainKey}
        onClose={() => setTransfer(null)}
      />
    </section>
  );
}
