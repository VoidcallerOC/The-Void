// Animated track art — looping muted video with the still PNG as poster/fallback.
// Falls back to a plain <img> when no video is available.
export function TrackArt({ art, vid, style }) {
  if (!vid) return <img src={art} alt="" style={style} />;
  return (
    <video
      key={vid}
      autoPlay
      loop
      muted
      playsInline
      poster={art}
      preload="auto"
      style={style}
    >
      <source src={vid + ".webm"} type="video/webm" />
      <source src={vid + ".mp4"} type="video/mp4" />
    </video>
  );
}

// ---------------- Atoms ----------------
export function Eyebrow({ children, red, style }) {
  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        color: red ? "var(--vc-crimson)" : "var(--vc-bone-dim)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Btn({ kind = "primary", children, onClick, style, disabled }) {
  const base = {
    fontFamily: "var(--font-body)",
    fontWeight: 700,
    fontSize: 12,
    letterSpacing: "0.2em",
    textTransform: "uppercase",
    padding: "14px 22px",
    border: "1px solid",
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "all 120ms cubic-bezier(0.6,0,0.2,1)",
    background: "transparent",
    color: "var(--vc-bone)",
    borderColor: "var(--vc-bone)",
    ...style,
  };
  const variants = {
    primary: {
      background: "var(--vc-crimson)",
      borderColor: "var(--vc-crimson)",
      color: "#fff",
      boxShadow: "0 0 32px -8px rgba(225,15,31,0.55)",
    },
    ghost: {},
    ash: { color: "var(--vc-bone-dim)", borderColor: "var(--vc-ash)" },
  };
  const dis = disabled
    ? { color: "rgba(242,237,226,0.3)", borderColor: "rgba(242,237,226,0.15)", background: "transparent", boxShadow: "none" }
    : {};
  return (
    <button
      style={{ ...base, ...variants[kind], ...dis }}
      onClick={disabled ? undefined : onClick}
      onMouseEnter={(e) => {
        if (disabled) return;
        if (kind === "primary") {
          e.currentTarget.style.background = "var(--vc-ember)";
          e.currentTarget.style.borderColor = "var(--vc-ember)";
          e.currentTarget.style.boxShadow = "0 0 32px -4px rgba(255,61,46,0.7)";
          // 1-frame RGB-split flicker — reset to none first so it replays each hover
          e.currentTarget.style.animation = "none";
          // force reflow, then trigger
          void e.currentTarget.offsetWidth;
          e.currentTarget.style.animation = "vc-rgb-flicker 140ms steps(3) 1";
        } else if (kind === "ghost") {
          e.currentTarget.style.color = "var(--vc-crimson)";
          e.currentTarget.style.borderColor = "var(--vc-crimson)";
        }
      }}
      onMouseDown={(e) => {
        if (disabled) return;
        e.currentTarget.style.transform = "translateY(1px)";
        e.currentTarget.style.boxShadow = "none";
      }}
      onMouseUp={(e) => {
        if (disabled) return;
        e.currentTarget.style.transform = "translateY(0)";
        if (kind === "primary") e.currentTarget.style.boxShadow = "0 0 32px -4px rgba(255,61,46,0.7)";
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        Object.assign(e.currentTarget.style, base, variants[kind]);
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.animation = "none";
      }}
    >
      {children}
    </button>
  );
}

export function Tag({ children, kind = "bone", pulse }) {
  const styles = {
    bone: { color: "var(--vc-bone)", borderColor: "var(--vc-smoke)", background: "transparent" },
    crimson: { color: "#fff", background: "var(--vc-blood)", borderColor: "var(--vc-blood)" },
    outline: { color: "var(--vc-crimson)", borderColor: "var(--vc-crimson)", background: "transparent" },
    ash: { color: "var(--vc-bone-dim)", borderColor: "var(--vc-ash)", background: "transparent" },
  };
  return (
    <span
      style={{
        fontFamily: "var(--font-body)",
        fontWeight: 700,
        fontSize: 10,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        padding: "5px 10px",
        border: "1px solid",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        ...styles[kind],
      }}
    >
      {pulse && (
        <span
          style={{
            width: 6,
            height: 6,
            background: "var(--vc-ember)",
            borderRadius: 999,
            boxShadow: "0 0 8px var(--vc-ember)",
            animation: "vc-pulse 1.4s ease-in-out infinite",
          }}
        />
      )}
      {children}
    </span>
  );
}
