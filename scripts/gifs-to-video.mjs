// Convert the track-art GIFs to small looping web video (mp4 + webm).
// mp4/h264 is the universal fallback; webm/vp9 is smaller where supported.
// Output scaled to 256px (retina for an ~84px display); CSS crops to square.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import ffmpeg from "ffmpeg-static";

const A = path.resolve("public/assets");
const OUT = path.join(A, "track-art-vid");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// [source gif, output slug]
const map = [
  ["track-art/ep1-the-hollow.gif",     "ep1-the-hollow"],
  ["track-art/ep1-dont-look-down.gif", "ep1-dont-look-down"],
  ["track-art/ep1-complex.gif",        "ep1-complex"],
  ["track-art/ep1-enough.gif",         "ep1-enough"],
  ["Voidcaller_1.gif", "ep2-warning-signs"],
  ["Voidcaller_2.gif", "ep2-pathway"],
  ["Voidcaller_3.gif", "ep2-immerse"],
  ["Voidcaller_4.gif", "ep2-aligned"],
  ["Voidcaller_5.gif", "ep2-the-noise"],
  ["Voidcaller_6.gif", "ep2-lessons-learned"],
];

const kb = (p) => (statSync(p).size / 1024).toFixed(0);

for (const [src, slug] of map) {
  const inPath = path.join(A, src);
  const mp4 = path.join(OUT, `${slug}.mp4`);
  const webm = path.join(OUT, `${slug}.webm`);
  // mp4 (h264) — even dims + yuv420p for Safari/iOS
  execFileSync(ffmpeg, [
    "-v", "quiet", "-y", "-i", inPath,
    "-vf", "scale=256:-2:flags=lanczos",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "28", "-preset", "veryslow",
    "-an", "-movflags", "+faststart", mp4,
  ]);
  // webm (vp9) — best effort
  let webmKb = "—";
  try {
    execFileSync(ffmpeg, [
      "-v", "quiet", "-y", "-i", inPath,
      "-vf", "scale=256:-2:flags=lanczos",
      "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0", "-an", webm,
    ]);
    webmKb = kb(webm);
  } catch { webmKb = "FAILED"; }
  console.log(`${slug.padEnd(20)} gif ${kb(inPath).padStart(6)}KB → mp4 ${kb(mp4).padStart(4)}KB  webm ${String(webmKb).padStart(4)}KB`);
}
