import { useRef } from "react";

// ---------------- Texture overlays ----------------
export function Grain({ opacity = 0.06 }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        opacity,
        mixBlendMode: "overlay",
        zIndex: 9998,
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>\")",
      }}
    />
  );
}

export function Scanlines() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 9997,
        background:
          "repeating-linear-gradient(0deg, transparent 0px, transparent 2px, rgba(255,255,255,0.025) 2px, rgba(255,255,255,0.025) 3px)",
      }}
    />
  );
}

// Chromatic-aberration text. Renders the same text 3× stacked.
// Each instance gets its own random duration + start offset so multiple
// Glitch elements on a page tear independently of one another. The two
// ghost layers of a single instance share timing so the R/C split stays coherent.
export function Glitch({ children, size = 80, weight = 900, italic, style }) {
  const sz = typeof size === "number" ? size + "px" : size;
  // computed once per mount, stable across re-renders
  const timing = useRef(null);
  if (timing.current === null) {
    const dur = (2.67 + Math.random() * 2.4).toFixed(2);  // 2.67s – 5.07s (1/3 slower)
    const delay = (-Math.random() * dur).toFixed(2);       // start mid-cycle
    timing.current = { dur, delay };
  }
  const { dur, delay } = timing.current;
  const base = {
    fontFamily: "var(--font-display)",
    fontWeight: weight,
    fontSize: sz,
    lineHeight: 0.95,
    letterSpacing: "0.01em",
    textTransform: "uppercase",
    fontStyle: italic ? "italic" : "normal",
  };
  return (
    <div style={{ position: "relative", ...base, ...style }}>
      <span style={{ position: "relative", color: "var(--vc-bone)", zIndex: 3 }}>{children}</span>
      <span
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          color: "#E10F1F",
          mixBlendMode: "screen",
          transform: "translate(-4px, 0)",
          zIndex: 2,
          animation: `vc-shift-a ${dur}s steps(1, end) ${delay}s infinite`,
        }}
      >
        {children}
      </span>
      <span
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          color: "#4DE3E1",
          mixBlendMode: "screen",
          transform: "translate(4px, 0)",
          zIndex: 1,
          animation: `vc-shift-b ${dur}s steps(1, end) ${delay}s infinite`,
        }}
      >
        {children}
      </span>
    </div>
  );
}

// Wordmark with chromatic-aberration ghosts — uses the carved logotype image.
export function WordmarkGlitch() {
  const src = "/assets/voidcaller_wordmark.png";
  // independent random timing, same model as <Glitch>
  const timing = useRef(null);
  if (timing.current === null) {
    const dur = (2.67 + Math.random() * 2.4).toFixed(2);
    const delay = (-Math.random() * dur).toFixed(2);
    timing.current = { dur, delay };
  }
  const { dur, delay } = timing.current;
  const layer = (filter, x, blend, op, anim) => ({
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "contain",
    objectPosition: "left center",
    filter,
    transform: `translate(${x}px, 0)`,
    mixBlendMode: blend,
    opacity: op,
    animation: `${anim} ${dur}s steps(1, end) ${delay}s infinite`,
  });
  return (
    <div
      style={{
        position: "relative",
        width: "min(100%, 880px)",
        aspectRatio: "1500 / 500",
        margin: "8px 0",
      }}
    >
      <img
        src={src}
        alt=""
        aria-hidden
        style={layer(
          "brightness(0) saturate(100%) invert(13%) sepia(91%) saturate(7484%) hue-rotate(355deg) brightness(95%) contrast(110%)",
          -7,
          "screen",
          0.9,
          "vc-wordmark-a"
        )}
      />
      <img
        src={src}
        alt=""
        aria-hidden
        style={layer(
          "brightness(0) saturate(100%) invert(91%) sepia(38%) saturate(381%) hue-rotate(135deg) brightness(94%) contrast(86%)",
          7,
          "screen",
          0.55,
          "vc-wordmark-b"
        )}
      />
      <img
        src={src}
        alt="VOIDCALLER"
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          objectFit: "contain",
          objectPosition: "left center",
          display: "block",
          zIndex: 3,
          filter: "drop-shadow(0 0 36px rgba(225,15,31,0.25))",
        }}
      />
    </div>
  );
}
