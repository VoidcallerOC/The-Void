import { useState, useEffect } from "react";
import { VC_DATA } from "../data.js";
import { RELIC_TOKEN_IDS } from "./web3.js";
import { requestProtectedMediaGrant, revokeProtectedMediaGrant } from "./media-auth.js";

function grantKey(track) { return `${track?.protectedMedia?.experienceId || ""}:${track?.protectedMedia?.mediaType || "AUDIO"}:${track?.n || ""}`; }

// Percent, not basis points. 80 is audible and not muted when nothing is stored.
export const MASTER_VOLUME_STORAGE_KEY = "the-void.master-volume";
export const DEFAULT_MASTER_VOLUME_PERCENT = 80;

function browserStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

// null when the value is not a real level. 0 is a valid mute.
export function parseMasterVolumePercent(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    value = trimmed;
  }
  const level = Number(value);
  if (!Number.isFinite(level)) return null;
  return Math.min(100, Math.max(0, Math.round(level)));
}

export function readMasterVolumePercent(store = browserStorage()) {
  try {
    const raw = store?.getItem?.(MASTER_VOLUME_STORAGE_KEY);
    if (raw == null) return DEFAULT_MASTER_VOLUME_PERCENT;
    return parseMasterVolumePercent(raw) ?? DEFAULT_MASTER_VOLUME_PERCENT;
  } catch {
    return DEFAULT_MASTER_VOLUME_PERCENT;
  }
}

export function writeMasterVolumePercent(percent, store = browserStorage()) {
  try {
    store?.setItem?.(MASTER_VOLUME_STORAGE_KEY, String(percent));
  } catch {
    // Private mode and blocked storage still keep the in-memory level for this session.
  }
}

// Shared audio state lives in a module-level singleton so the StickyPlayer
// can mirror it without React lifting state up the tree. Full media URLs are
// never present in the catalog; bearer playback is resolved through the API.
export const VC_AUDIO = {
  el: null,
  idx: 0,
  playing: false,
  queue: null,
  queueId: "tunnel-vision",
  queueLabel: null,
  listeners: new Set(),
  owned: new Set(),
  mediaAuthorization: null,
  mediaGrants: new Map(),
  mediaRequests: new Map(),
  // null until the first read so a stored level wins over the default.
  volumePercent: null,

  masterVolumePercent() {
    if (this.volumePercent == null) this.volumePercent = readMasterVolumePercent();
    return this.volumePercent;
  },

  applyMasterVolume(audio = this.el) {
    if (!audio) return;
    audio.volume = this.masterVolumePercent() / 100;
  },

  setMasterVolumePercent(percent) {
    const next = parseMasterVolumePercent(percent);
    if (next == null) return;
    this.volumePercent = next;
    writeMasterVolumePercent(next);
    this.applyMasterVolume();
    this.notify();
  },

  holdsChapterI() {
    return RELIC_TOKEN_IDS.some((id) => this.owned.has(id));
  },

  setMediaAuthorization({ wallet = null, authHeaders = {} } = {}) {
    const normalizedWallet = wallet?.toLowerCase() || null;
    if (normalizedWallet !== this.mediaAuthorization?.wallet) this.mediaGrants.clear();
    this.mediaAuthorization = normalizedWallet ? { wallet: normalizedWallet, authHeaders } : null;
    this.notify();
  },

  async revokeMediaGrants() {
    const authorization = this.mediaAuthorization;
    const grants = [...this.mediaGrants.values()];
    this.mediaGrants.clear();
    this.mediaRequests.clear();
    if (!authorization) { this.notify(); return; }
    await Promise.allSettled(grants.map((grant) => revokeProtectedMediaGrant({ wallet: authorization.wallet, grantId: grant.grantId, authHeaders: authorization.authHeaders })));
    this.notify();
  },

  hasAuthorizedSource(track) {
    const grant = this.mediaGrants.get(grantKey(track));
    return Boolean(grant?.accessUrl && new Date(grant.expiresAt).getTime() > Date.now());
  },

  isGated(track) {
    if (!track) return false;
    if (track.protectedMedia) return !this.hasAuthorizedSource(track);
    if (track.tokenId != null && RELIC_TOKEN_IDS.includes(track.tokenId)) return !!(track.previewSrc && !this.holdsChapterI());
    return !!(track.previewSrc && track.tokenId != null && !this.owned.has(track.tokenId));
  },

  srcFor(track) {
    if (track?.protectedMedia) {
      const accessUrl = this.mediaGrants.get(grantKey(track))?.accessUrl;
      if (accessUrl) return accessUrl;
      // A connected, authenticated holder is waiting for the protected grant.
      // Do not start the public preview while that authorization is pending.
      if (this.holdsChapterI() && this.mediaAuthorization?.wallet) return null;
      return track.previewSrc || null;
    }
    return this.isGated(track) ? (track.previewSrc || track.src) : track.src;
  },

  isPreview(track) {
    return !!(track && (track.preview || this.isGated(track)));
  },

  isBearer(track) {
    return !!(track?.protectedMedia && this.hasAuthorizedSource(track));
  },

  async resolveProtectedSource(track) {
    if (!track?.protectedMedia || !this.holdsChapterI() || !this.mediaAuthorization?.wallet) return null;
    const key = grantKey(track);
    const existing = this.mediaGrants.get(key);
    if (existing && new Date(existing.expiresAt).getTime() > Date.now()) return existing.accessUrl;
    if (!this.mediaRequests.has(key)) {
      const request = requestProtectedMediaGrant({ wallet: this.mediaAuthorization.wallet, experienceId: track.protectedMedia.experienceId, mediaType: track.protectedMedia.mediaType || "AUDIO", authHeaders: this.mediaAuthorization.authHeaders })
        .then((grant) => { this.mediaGrants.set(key, grant); return grant; })
        .finally(() => this.mediaRequests.delete(key));
      this.mediaRequests.set(key, request);
    }
    const grant = await this.mediaRequests.get(key);
    return grant.accessUrl;
  },

  // Play a track whose protected source was already authorized elsewhere
  // (e.g. the experience page's unlock), through the one shared player.
  playGranted(track, grant, queueId, queueLabel = null) {
    this.mediaGrants.set(grantKey(track), grant);
    this.setQueue([track], queueId, queueLabel);
    return this.play(0);
  },

  setOwnership(tokenIds) {
    this.owned = new Set(tokenIds || []);
    const track = this.queue && this.queue[this.idx];
    if (this.el && track) this.setTrack(this.idx);
    this.notify();
  },

  ensure() {
    if (this.el) return this.el;
    if (!this.queue) this.queue = VC_DATA.tracklist;
    const audio = new Audio();
    audio.preload = "metadata";
    audio.crossOrigin = "anonymous";
    audio.addEventListener("ended", () => this.play((this.idx + 1) % this.queue.length));
    audio.addEventListener("timeupdate", () => this.notify());
    audio.addEventListener("play", () => { this.playing = true; this.notify(); });
    audio.addEventListener("pause", () => { this.playing = false; this.notify(); });
    audio.addEventListener("loadedmetadata", () => this.notify());
    this.el = audio;
    this.applyMasterVolume(audio);
    return audio;
  },

  setQueue(tracks, queueId, queueLabel = null) {
    this.queue = tracks;
    this.queueId = queueId || "queue";
    this.queueLabel = queueLabel || null;
    this.idx = 0;
    if (this.el) {
      this.el.pause();
      this.el.removeAttribute("src");
      this.el.load();
    }
    this.notify();
  },

  setTrack(index) {
    const audio = this.ensure();
    const track = this.queue[index];
    if (!track) return;
    this.idx = index;
    const source = this.srcFor(track);
    const current = audio.getAttribute("src") || audio.src || "";
    if (source && !current.endsWith(source.split("/").pop())) audio.src = source;
    else if (!source && current) {
      audio.removeAttribute("src");
      audio.load();
    }
    this.applyMasterVolume(audio);
    if (track.protectedMedia && this.holdsChapterI()) {
      void this.resolveProtectedSource(track).then((authorizedSource) => {
        if (!authorizedSource || this.queue?.[this.idx] !== track) return;
        const currentSource = audio.getAttribute("src") || audio.src || "";
        if (currentSource.endsWith(authorizedSource.split("/").pop())) return;
        const wasPlaying = !audio.paused;
        const time = audio.currentTime || 0;
        audio.src = authorizedSource;
        this.applyMasterVolume(audio);
        const resume = () => {
          try { audio.currentTime = Math.min(time, audio.duration || time); } catch { /* Metadata may not be available yet. */ }
          if (wasPlaying) audio.play().catch(() => {});
        };
        audio.addEventListener("loadedmetadata", resume, { once: true });
        this.notify();
      }).catch(() => this.notify());
    }
  },

  play(index) {
    if (typeof index === "number") this.setTrack(index);
    else {
      this.ensure();
      if (!this.el.src) this.setTrack(this.idx);
    }
    this.applyMasterVolume();
    return this.el.play().catch((error) => {
      this.notify();
      throw error;
    });
  },

  pause() { if (this.el) this.el.pause(); },
  toggle() { this.ensure(); if (this.el.paused) this.play(); else this.pause(); },
  next() { this.play((this.idx + 1) % this.queue.length); },
  prev() { this.play((this.idx - 1 + this.queue.length) % this.queue.length); },
  seekFrac(fraction) { const audio = this.ensure(); if (audio.duration) audio.currentTime = Math.max(0, Math.min(audio.duration, audio.duration * fraction)); },
  notify() { this.listeners.forEach((listener) => listener()); },
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
};

export function useAudio() {
  const [, setTick] = useState(0);
  useEffect(() => VC_AUDIO.subscribe(() => setTick((tick) => tick + 1)), []);
  return VC_AUDIO;
}

export function fmt(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}
