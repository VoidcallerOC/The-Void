import { useEffect, useRef } from "react";

/**
 * Ambient starfield behind every page of The Void (mounted once in Layout).
 *
 * Three depth layers (far dust, mid stars, a few near stars with a soft halo)
 * drift very slowly along one shared heading, offset by scroll at different
 * rates so the page reads as sitting inside a deep volume. Bone-white points,
 * a rare blood-tinted near star, and an occasional far star that swells and
 * fades over several seconds keep it quietly uncanny.
 *
 * Decorative only: aria-hidden, pointer-events: none. Pointer position is read
 * from window listeners (passive), so the canvas is never a click target.
 *
 * Cost control: no React state per frame; star data lives in typed arrays
 * allocated once per resize; ~30fps cap; device-pixel-ratio cap; density by
 * device class rather than by area; the loop stops when the tab is hidden; and
 * prefers-reduced-motion renders one static frame with no loop at all.
 */

const FRAME_MS = 1000 / 30;
// One shared, very slow heading for the whole field (px/s at depth 1).
const HEADING_X = -0.82;
const HEADING_Y = 0.57;

// depth: drift + parallax multiplier. Counts are per device class, not area.
const LAYERS = [
  { name: "far", depth: 0.18, speed: 0.9, scroll: 0.03, size: [0.6, 1.1], alpha: [0.32, 0.68], pointer: 0, counts: { desktop: 240, tablet: 145, mobile: 88 } },
  { name: "mid", depth: 0.45, speed: 2.2, scroll: 0.07, size: [1, 1.6], alpha: [0.5, 0.88], pointer: 0.45, counts: { desktop: 100, tablet: 62, mobile: 36 } },
  { name: "near", depth: 1, speed: 4.2, scroll: 0.13, size: [1.25, 2.05], alpha: [0.6, 0.88], pointer: 1, counts: { desktop: 18, tablet: 12, mobile: 8 } },
];

const POINTER_RADIUS = 150; // CSS px
const POINTER_PUSH = 7; // max displacement at the pointer, CSS px
const POINTER_EASE = 0.06; // per frame, toward the target offset

// Small deterministic PRNG so the field composes the same way on every visit.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deviceClass(width, coarse) {
  if (width < 600) return "mobile";
  if (width < 1024 || coarse) return "tablet";
  return "desktop";
}

function lowPower() {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 8 : 8;
  const saveData = typeof navigator !== "undefined" && navigator.connection?.saveData;
  return cores <= 4 || Boolean(saveData);
}

// Soft halo sprite for near stars, rendered once.
function haloSprite(tint) {
  const size = 32;
  const sprite = document.createElement("canvas");
  sprite.width = size;
  sprite.height = size;
  const g = sprite.getContext("2d");
  const gradient = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, `rgba(${tint}, 0.7)`);
  gradient.addColorStop(0.18, `rgba(${tint}, 0.28)`);
  gradient.addColorStop(0.5, `rgba(${tint}, 0.05)`);
  gradient.addColorStop(1, `rgba(${tint}, 0)`);
  g.fillStyle = gradient;
  g.fillRect(0, 0, size, size);
  return sprite;
}

function buildField(width, height, klass, reduce) {
  const random = mulberry32(0x5f3759df);
  const scale = lowPower() ? 0.6 : 1;
  return LAYERS.map((layer) => {
    const count = Math.max(4, Math.round(layer.counts[klass] * scale));
    const x = new Float32Array(count);
    const y = new Float32Array(count);
    const size = new Float32Array(count);
    const alpha = new Float32Array(count);
    const phase = new Float32Array(count);
    const period = new Float32Array(count);
    const ox = new Float32Array(count);
    const oy = new Float32Array(count);
    const blood = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      x[i] = random() * width;
      y[i] = random() * height;
      size[i] = layer.size[0] + random() * (layer.size[1] - layer.size[0]);
      // Bias toward faint: most stars sit near the bottom of the alpha range.
      const t = random();
      alpha[i] = layer.alpha[0] + t * t * (layer.alpha[1] - layer.alpha[0]);
      phase[i] = random() * Math.PI * 2;
      period[i] = 9000 + random() * 14000; // 9–23s breathing, never a twinkle
      blood[i] = layer.name === "near" && random() < 0.16 ? 1 : 0;
    }
    return { ...layer, count, x, y, size, alpha, phase, period, ox, oy, blood, reduce };
  });
}

export function VoidStarfield() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: true });
    if (!canvas || !ctx) return undefined;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const coarseQuery = window.matchMedia("(pointer: coarse)");
    const boneHalo = haloSprite("242, 237, 226");
    const bloodHalo = haloSprite("225, 15, 31");

    let width = 0;
    let height = 0;
    let dpr = 1;
    let layers = [];
    let raf = 0;
    let last = 0;
    let elapsed = 0;
    let pointerX = -1e4;
    let pointerY = -1e4;
    let reduce = motionQuery.matches;
    // One far star at a time slowly swells and fades: the uncanny "glint".
    let glintIndex = -1;
    let glintStart = 0;
    let nextGlint = 14000;
    const GLINT_MS = 6500;

    const resize = () => {
      const coarse = coarseQuery.matches;
      width = window.innerWidth;
      height = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.25 : 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      layers = buildField(width, height, deviceClass(width, coarse), reduce);
      glintIndex = -1;
    };

    const draw = (now) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const scrollY = reduce ? 0 : window.scrollY || 0;
      const seconds = elapsed / 1000;
      const pointerActive = !reduce && !coarseQuery.matches && pointerX > -1e3;

      for (let l = 0; l < layers.length; l++) {
        const layer = layers[l];
        const driftX = reduce ? 0 : HEADING_X * layer.speed * seconds;
        const driftY = reduce ? 0 : HEADING_Y * layer.speed * seconds - scrollY * layer.scroll;
        const near = layer.name === "near";
        ctx.fillStyle = "rgb(242, 237, 226)";
        for (let i = 0; i < layer.count; i++) {
          // Wrap into the viewport with a small margin so stars never pop at the edge.
          let px = (layer.x[i] + driftX) % (width + 40);
          if (px < -20) px += width + 40;
          let py = (layer.y[i] + driftY) % (height + 40);
          if (py < -20) py += height + 40;

          if (layer.pointer) {
            let tx = 0;
            let ty = 0;
            if (pointerActive) {
              const dx = px - pointerX;
              const dy = py - pointerY;
              const distSq = dx * dx + dy * dy;
              if (distSq < POINTER_RADIUS * POINTER_RADIUS && distSq > 0.01) {
                const dist = Math.sqrt(distSq);
                const falloff = 1 - dist / POINTER_RADIUS;
                const push = POINTER_PUSH * layer.pointer * falloff * falloff;
                tx = (dx / dist) * push;
                ty = (dy / dist) * push;
              }
            }
            layer.ox[i] += (tx - layer.ox[i]) * POINTER_EASE;
            layer.oy[i] += (ty - layer.oy[i]) * POINTER_EASE;
            px += layer.ox[i];
            py += layer.oy[i];
          }

          let a = layer.alpha[i];
          if (!reduce) a *= 0.82 + 0.18 * Math.sin(layer.phase[i] + (now / layer.period[i]) * Math.PI * 2);
          if (layer.name === "far" && i === glintIndex) {
            const p = (now - glintStart) / GLINT_MS;
            if (p >= 0 && p <= 1) a = Math.min(0.85, a + Math.sin(p * Math.PI) * 0.55);
          }

          if (near) {
            const halo = layer.size[i] * 9;
            ctx.globalAlpha = a;
            ctx.drawImage(layer.blood[i] ? bloodHalo : boneHalo, px - halo / 2, py - halo / 2, halo, halo);
            ctx.globalAlpha = Math.min(1, a * 1.6);
            const s = layer.size[i];
            ctx.fillRect(px - s / 2, py - s / 2, s, s);
          } else {
            ctx.globalAlpha = a;
            const s = layer.size[i];
            ctx.fillRect(px - s / 2, py - s / 2, s, s);
          }
        }
      }
      ctx.globalAlpha = 1;
    };

    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      if (now - last < FRAME_MS) return;
      const delta = last ? Math.min(now - last, 100) : FRAME_MS; // never jump after a stall
      last = now;
      elapsed += delta;
      if (elapsed > nextGlint && layers[0]?.count) {
        glintIndex = Math.floor((elapsed * 7919) % layers[0].count);
        glintStart = now;
        nextGlint = elapsed + 38000 + ((elapsed * 31) % 40000); // every ~40–80s
      }
      draw(now);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      if (reduce) { draw(0); return; }
      last = 0;
      raf = requestAnimationFrame(frame);
    };

    const onResize = () => { resize(); if (reduce) draw(0); };
    const onPointerMove = (event) => { pointerX = event.clientX; pointerY = event.clientY; };
    const onPointerLeave = () => { pointerX = -1e4; pointerY = -1e4; };
    const onVisibility = () => {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else start();
    };
    const onMotionChange = () => { reduce = motionQuery.matches; resize(); start(); };

    resize();
    start();
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("mouseleave", onPointerLeave, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    motionQuery.addEventListener?.("change", onMotionChange);

    return () => {
      cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("mouseleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      motionQuery.removeEventListener?.("change", onMotionChange);
    };
  }, []);

  return (
    <div className="vc-starfield" aria-hidden="true">
      <canvas ref={canvasRef} className="vc-starfield-canvas" />
    </div>
  );
}
