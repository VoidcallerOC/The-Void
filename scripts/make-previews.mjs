// Generate ~30s "best part" preview clips for the Tunnel Vision EP.
// Heuristic: decode each track to mono PCM, score every candidate window by
// sustained loudness (RMS), and pick the highest-energy window — in metalcore
// that reliably lands on the peak chorus/breakdown. Cuts with short fades.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import ffmpeg from "ffmpeg-static";

const ASSETS = path.resolve("public/assets");
const SR = 8000;                 // analysis sample rate (mono)
const BIN = 0.5;                 // seconds per energy bin
const BIN_SAMPLES = SR * BIN;
const CLIP = 30;                 // target clip length (s) — within the 20–40s ask
const HEAD_GUARD = 0.12;         // skip first 12% (intro) when choosing a start
const TAIL_GUARD = 3.0;          // leave 3s before the very end

const tracks = [
  ["01", "warning-signs",   "01-warning-signs.mp3"],
  ["02", "pathway",         "02-pathway.mp3"],
  ["03", "immerse",         "03-immerse.mp3"],
  ["04", "aligned",         "04-aligned.mp3"],
  ["05", "the-noise",       "05-the-noise.mp3"],
  ["06", "lessons-learned", "06-lessons-learned.mp3"],
];

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const results = [];

for (const [n, slug, file] of tracks) {
  const inPath = path.join(ASSETS, "audio", file);
  // decode to mono 8kHz signed-16 PCM
  const pcm = execFileSync(ffmpeg, ["-v", "quiet", "-i", inPath, "-ac", "1", "-ar", String(SR), "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  const samples = pcm.length / 2;
  const dur = samples / SR;

  // RMS energy per bin
  const nBins = Math.floor(samples / BIN_SAMPLES);
  const energy = new Float64Array(nBins);
  for (let b = 0; b < nBins; b++) {
    let sum = 0;
    const off = b * BIN_SAMPLES * 2;
    for (let i = 0; i < BIN_SAMPLES; i++) {
      const v = pcm.readInt16LE(off + i * 2);
      sum += v * v;
    }
    energy[b] = Math.sqrt(sum / BIN_SAMPLES);
  }

  // slide a CLIP-long window; constrain start to avoid intro/outro
  const winBins = Math.round(CLIP / BIN);
  const minStartBin = Math.round((dur * HEAD_GUARD) / BIN);
  const maxStartBin = Math.max(minStartBin, Math.floor((dur - CLIP - TAIL_GUARD) / BIN));
  let bestStart = minStartBin, bestScore = -1;
  for (let s = minStartBin; s <= maxStartBin; s++) {
    let score = 0;
    for (let k = 0; k < winBins && s + k < nBins; k++) score += energy[s + k];
    if (score > bestScore) { bestScore = score; bestStart = s; }
  }
  const startSec = bestStart * BIN;
  const clipLen = Math.min(CLIP, dur - startSec);

  // cut with 0.4s fades; re-encode 160kbps
  const outName = `ep2-${n}-${slug}-preview.mp3`;
  const outPath = path.join(ASSETS, "audio-preview", outName);
  execFileSync(ffmpeg, [
    "-v", "quiet", "-y",
    "-ss", startSec.toFixed(2), "-t", clipLen.toFixed(2), "-i", inPath,
    "-af", `afade=t=in:st=0:d=0.4,afade=t=out:st=${(clipLen - 0.4).toFixed(2)}:d=0.4`,
    "-ar", "44100", "-b:a", "160k",
    outPath,
  ]);

  results.push({ n, slug, dur: fmt(dur), start: fmt(startSec), end: fmt(startSec + clipLen), len: Math.round(clipLen), out: outName });
  console.log(`${n} ${slug.padEnd(16)} full ${fmt(dur)}  →  preview ${fmt(startSec)}–${fmt(startSec + clipLen)} (${Math.round(clipLen)}s)`);
}

writeFileSync(path.join(ASSETS, "audio-preview", "_previews.json"), JSON.stringify(results, null, 2));
