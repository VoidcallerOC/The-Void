// Structural energy analysis of two lead-single candidates.
// Shows the dynamic shape so we can judge: hook immediacy, number of peak
// sections, and the cleanest build-into-drop for a tension tease.
import { execFileSync } from "node:child_process";
import path from "node:path";
import ffmpeg from "ffmpeg-static";

const ASSETS = path.resolve("public/assets");
const SR = 8000, BIN = 1.0, BS = SR * BIN;
const candidates = [
  ["Pathway", "02-pathway.mp3"],
  ["Lessons Learned", "06-lessons-learned.mp3"],
];
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const blocks = " ▁▂▃▄▅▆▇█";

for (const [name, file] of candidates) {
  const pcm = execFileSync(ffmpeg, ["-v", "quiet", "-i", path.join(ASSETS, "audio", file), "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  const n = Math.floor((pcm.length / 2) / BS);
  const e = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    let s = 0; const off = b * BS * 2;
    for (let i = 0; i < BS; i++) { const v = pcm.readInt16LE(off + i * 2); s += v * v; }
    e[b] = Math.sqrt(s / BS);
  }
  let max = 0;
  for (let b = 0; b < n; b++) if (e[b] > max) max = e[b];
  const norm = Array.from(e, x => (max ? x / max : 0));
  const spark = norm.map(x => blocks[Math.max(0, Math.min(8, Math.round((x || 0) * 8)))]).join("");
  let peakBin = 0;
  for (let b = 0; b < n; b++) if (norm[b] >= norm[peakBin]) peakBin = b;

  // hook immediacy: first time it sustains >=0.8 for >=4s
  let immed = null;
  for (let b = 0; b + 4 < n; b++) {
    if (norm.slice(b, b + 4).every(x => x >= 0.8)) { immed = b; break; }
  }
  // count distinct high-energy sections (>=0.8), merging gaps <3s
  let sections = 0, inHi = false, gap = 0;
  for (let b = 0; b < n; b++) {
    if (norm[b] >= 0.8) { if (!inHi) sections++; inHi = true; gap = 0; }
    else { if (inHi) { gap++; if (gap > 3) inHi = false; } }
  }
  // steepest 8s rise in the BODY of the song (skip first 20s intro, last 5s)
  // that ramps into a high point — this is the tease candidate.
  let bestRise = 0, riseStart = 20;
  for (let b = 20; b + 8 < n - 5; b++) {
    const rise = norm[b + 8] - norm[b];
    if (norm[b + 8] >= 0.85 && norm[b] <= 0.6 && rise > bestRise) { bestRise = rise; riseStart = b; }
  }

  console.log(`\n${name}  (${fmt(n)})`);
  console.log(spark);
  console.log(`  hook hits hard at: ${immed != null ? fmt(immed) : "n/a (no sustained 0.8+ early)"}`);
  console.log(`  global peak:       ${fmt(peakBin)}`);
  console.log(`  peak sections:     ${sections}`);
  console.log(`  best build→drop:   ${fmt(riseStart)}–${fmt(riseStart + 8)}  (rise +${(bestRise * 100).toFixed(0)}%)`);
}
