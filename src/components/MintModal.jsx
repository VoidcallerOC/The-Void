import { VC_DATA } from "../data.js";
import { Eyebrow } from "./Atoms.jsx";
import { Glitch } from "./Overlays.jsx";
import { X, ExternalLink } from "lucide-react";
import { useDialog } from "../lib/useDialog.js";

// ---------------- Relic Modal (marketplace chooser) ----------------
// The self-titled EP is already minted; this modal sends people to OpenSea / Joepegs
// rather than running a fake mint flow.
export function MintModal({ open, onClose }) {
  const dialogRef = useDialog(open, onClose);
  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.86)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        animation: "vc-fade 220ms ease-out",
      }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Claim a Voidcaller relic"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: "100%",
          background: "var(--vc-void)",
          border: "1px solid var(--vc-crimson)",
          boxShadow: "0 0 100px -10px rgba(225,15,31,0.45)",
          padding: 36,
          position: "relative",
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            background: "transparent",
            border: 0,
            color: "var(--vc-bone)",
            cursor: "pointer",
            display: "inline-flex",
            padding: 0,
          }}
        >
          <X size={20} strokeWidth={1.75} />
        </button>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <Eyebrow red>† CLAIM A RELIC</Eyebrow>
          <div>
            <Glitch size="clamp(32px, 9vw, 44px)" weight={400} style={{ letterSpacing: 0, lineHeight: 1 }}>VOIDCALLER · I</Glitch>
          </div>
          <p style={{ margin: 0, color: "var(--vc-bone-dim)", fontSize: 14, lineHeight: 1.6 }}>
            The self-titled EP is already forged. Buy a relic on OpenSea or Joepegs. One Chapter I relic unlocks every track — fragments play for everyone else.
          </p>

          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--vc-bone-dim)",
              padding: "10px 12px",
              border: "1px solid var(--vc-ash)",
              wordBreak: "break-all",
            }}
          >
            <span style={{ color: "var(--vc-crimson)" }}>chain › </span>
            AVALANCHE C-CHAIN
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 6 }}>
            {VC_DATA.marketplaces.filter(m => m.name !== "SNOWTRACE").map((m, i) => (
              <a
                key={m.name}
                href={m.href}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  textDecoration: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "18px 20px",
                  background: i === 0 ? "var(--vc-crimson)" : "var(--vc-abyss)",
                  border: "1px solid " + (i === 0 ? "var(--vc-crimson)" : "var(--vc-ash)"),
                  color: i === 0 ? "#fff" : "var(--vc-bone)",
                  fontFamily: "var(--font-body)",
                  fontWeight: 700,
                  fontSize: 12,
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  transition: "all 120ms cubic-bezier(0.6,0,0.2,1)",
                  boxShadow: i === 0 ? "0 0 32px -8px rgba(225,15,31,0.55)" : "none",
                }}
                onMouseEnter={(e) => {
                  if (i === 0) {
                    e.currentTarget.style.background = "var(--vc-ember)";
                    e.currentTarget.style.borderColor = "var(--vc-ember)";
                  } else {
                    e.currentTarget.style.borderColor = "var(--vc-crimson)";
                    e.currentTarget.style.color = "var(--vc-crimson)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (i === 0) {
                    e.currentTarget.style.background = "var(--vc-crimson)";
                    e.currentTarget.style.borderColor = "var(--vc-crimson)";
                  } else {
                    e.currentTarget.style.borderColor = "var(--vc-ash)";
                    e.currentTarget.style.color = "var(--vc-bone)";
                  }
                }}
              >
                <span>VIEW ON {m.name}</span>
                <ExternalLink size={16} strokeWidth={1.75} />
              </a>
            ))}
          </div>

          <div style={{ display: "flex", justifyContent: "center", gap: 24, marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.14em", color: "var(--vc-bone-dim)", textTransform: "uppercase" }}>
            <span>† THE CHAIN REMEMBERS †</span>
          </div>
        </div>
      </div>
    </div>
  );
}
