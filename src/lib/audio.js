import { useState, useEffect } from "react";
import { VC_DATA } from "../data.js";
import { RELIC_TOKEN_IDS } from "./web3.js";

// Shared audio state lives in a module-level singleton so the StickyPlayer
// can mirror it without React lifting state up the tree.
export const VC_AUDIO = {
  el: null,
  idx: 0,
  playing: false,
  // Default queue = the upcoming Tunnel Vision EP. Switch via setQueue().
  queue: null,
  queueId: "tunnel-vision",
  listeners: new Set(),
  // Released-EP token ids the connected wallet owns (C-Chain or Grotto).
  owned: new Set(),

  holdsChapterI() {
    return RELIC_TOKEN_IDS.some((id) => this.owned.has(id));
  },

  // A released Chapter I track is gated unless the wallet holds ANY Chapter I relic.
  // Unreleased / fragment-only tracks (preview: true, no token) stay fragments.
  isGated(t) {
    if (!t) return false;
    if (t.tokenId != null && RELIC_TOKEN_IDS.includes(t.tokenId)) {
      return !!(t.previewSrc && !this.holdsChapterI());
    }
    // Preview-only tracks remain fragments, but are not ownership-gated.
    return !!(t.previewSrc && t.tokenId != null && !this.owned.has(t.tokenId));
  },
  // Resolved source for a track, honoring ownership gating.
  srcFor(t) {
    return this.isGated(t) ? (t.previewSrc || t.src) : t.src;
  },
  // Currently loaded source is a fragment (gated release OR unreleased clip).
  isPreview(t) {
    return !!(t && (t.preview || this.isGated(t)));
  },
  isBearer(t) {
    return !!(t && t.tokenId != null && !this.isGated(t));
  },
  // Called by WalletContext whenever ownership changes. Upgrades/downgrades the
  // currently-loaded released track in place if its gating status flipped.
  setOwnership(tokenIds) {
    this.owned = new Set(tokenIds || []);
    const t = this.queue && this.queue[this.idx];
    if (this.el && t && (t.previewSrc || t.src)) {
      const want = this.srcFor(t);
      const current = this.el.getAttribute("src") || this.el.src || "";
      if (!current.endsWith(want.split("/").pop())) {
        const wasPlaying = !this.el.paused;
        const time = this.el.currentTime || 0;
        this.el.src = want;
        const resume = () => {
          try { this.el.currentTime = Math.min(time, this.el.duration || time); } catch { /* ignore */ }
          if (wasPlaying) this.el.play().catch(() => {});
        };
        this.el.addEventListener("loadedmetadata", resume, { once: true });
      }
    }
    this.notify();
  },
  ensure() {
    if (this.el) return this.el;
    if (!this.queue) this.queue = VC_DATA.tracklist;
    const a = new Audio();
    a.preload = "metadata";
    a.crossOrigin = "anonymous";
    a.addEventListener("ended", () => {
      const next = (this.idx + 1) % this.queue.length;
      this.play(next);
    });
    a.addEventListener("timeupdate", () => this.notify());
    a.addEventListener("play",  () => { this.playing = true; this.notify(); });
    a.addEventListener("pause", () => { this.playing = false; this.notify(); });
    a.addEventListener("loadedmetadata", () => this.notify());
    this.el = a;
    return a;
  },
  setQueue(tracks, queueId) {
    this.queue = tracks;
    this.queueId = queueId || "queue";
    this.idx = 0;
    if (this.el) {
      this.el.pause();
      this.el.removeAttribute("src");
      this.el.load();
    }
    this.notify();
  },
  setTrack(i) {
    const a = this.ensure();
    const t = this.queue[i];
    if (!t) return;
    this.idx = i;
    const src = this.srcFor(t);
    const current = a.getAttribute("src") || a.src || "";
    if (!current.endsWith(src.split("/").pop())) {
      a.src = src;
    }
  },
  play(i) {
    if (typeof i === "number") this.setTrack(i);
    else {
      this.ensure();
      // First play on a fresh load: no source is loaded yet (setQueue clears
      // it and setTrack hasn't run), so load the current track before playing.
      if (!this.el.src) this.setTrack(this.idx);
    }
    this.el.play().catch(() => {});
  },
  pause() { if (this.el) this.el.pause(); },
  toggle() {
    this.ensure();
    if (this.el.paused) this.play();
    else this.pause();
  },
  next() { this.play((this.idx + 1) % this.queue.length); },
  prev() { this.play((this.idx - 1 + this.queue.length) % this.queue.length); },
  seekFrac(f) {
    const a = this.ensure();
    if (a.duration) a.currentTime = Math.max(0, Math.min(a.duration, a.duration * f));
  },
  notify() { this.listeners.forEach(fn => fn()); },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
};

export function useAudio() {
  const [, setTick] = useState(0);
  useEffect(() => VC_AUDIO.subscribe(() => setTick(t => t + 1)), []);
  return VC_AUDIO;
}

export function fmt(s) {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${ss}`;
}
