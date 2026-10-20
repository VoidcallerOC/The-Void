import { useState, useEffect } from "react";
import { VC_DATA } from "../data.js";
import { RELIC_TOKEN_IDS } from "./web3.js";
import { requestProtectedMediaGrant, revokeProtectedMediaGrant } from "./media-auth.js";

function grantKey(track) { return `${track?.protectedMedia?.experienceId || ""}:${track?.protectedMedia?.mediaType || "AUDIO"}:${track?.n || ""}`; }

// Two track objects describe the same playback when they name the same
// token and protected experience (pages rebuild track objects on render).
export function sameTrack(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  return String(left.n ?? "") === String(right.n ?? "")
    && (left.src || "") === (right.src || "")
    && (left.protectedMedia?.experienceId || "") === (right.protectedMedia?.experienceId || "")
    && (left.protectedMedia?.mediaType || "AUDIO") === (right.protectedMedia?.mediaType || "AUDIO");
}

const MEDIA_ERROR_MESSAGES = Object.freeze({
  1: "Playback was interrupted.",
  2: "The stream was interrupted. Press play to resume.",
  3: "This audio could not be decoded.",
  4: "The audio source could not be loaded.",
});
export function playbackErrorMessage(code) { return MEDIA_ERROR_MESSAGES[Number(code)] || "Playback could not continue."; }

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
  // Grant keys this wallet session has already been issued: a bearer stream
  // that stops when its grant lapses is renewed without re-checking the
  // browser-side ownership heuristics (the gateway decides on every grant).
  grantedKeys: new Set(),
  renewals: new Map(),
  // The last element error for the current track, for the UI to report.
  lastError: null,
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
  isProtectedHolder(track) {
    return Boolean(track?.protectedMedia && (this.holdsChapterI() || (track.tokenId != null && this.owned.has(String(track.tokenId)))));
  },

  setMediaAuthorization({ wallet = null, authHeaders = {} } = {}) {
    const normalizedWallet = wallet?.toLowerCase() || null;
    if (normalizedWallet !== this.mediaAuthorization?.wallet) { this.mediaGrants.clear(); this.grantedKeys.clear(); }
    this.mediaAuthorization = normalizedWallet ? { wallet: normalizedWallet, authHeaders } : null;
    this.notify();
  },

  async revokeMediaGrants() {
    const authorization = this.mediaAuthorization;
    const grants = [...this.mediaGrants.values()];
    this.mediaGrants.clear();
    this.mediaRequests.clear();
    this.grantedKeys.clear();
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
    return !!(track.previewSrc && track.tokenId != null && !this.owned.has(String(track.tokenId)));
  },

  srcFor(track) {
    if (track?.protectedMedia) {
      const accessUrl = this.mediaGrants.get(grantKey(track))?.accessUrl;
      if (accessUrl) return accessUrl;
      // A connected, authenticated holder is waiting for the protected grant.
      // Do not start the public preview while that authorization is pending.
      if (this.isProtectedHolder(track) && this.mediaAuthorization?.wallet) return null;
      return track.previewSrc || null;
    }
    return this.isGated(track) ? (track.previewSrc || track.src) : track.src;
  },

  isPreview(track) {
    return !!(track && !this.hasAuthorizedSource(track) && (track.preview || this.isGated(track)));
  },

  isBearer(track) {
    return !!(track?.protectedMedia && this.hasAuthorizedSource(track));
  },

  // A track whose grant may be requested here: a browser-side holder, or any
  // track this wallet session was already granted (renewal after expiry).
  canRequestGrant(track) {
    return Boolean(track?.protectedMedia && this.mediaAuthorization?.wallet && (this.isProtectedHolder(track) || this.grantedKeys.has(grantKey(track))));
  },

  async resolveProtectedSource(track) {
    if (!this.canRequestGrant(track)) return null;
    const key = grantKey(track);
    const existing = this.mediaGrants.get(key);
    if (existing && new Date(existing.expiresAt).getTime() > Date.now()) return existing.accessUrl;
    if (!this.mediaRequests.has(key)) {
      const request = requestProtectedMediaGrant({ wallet: this.mediaAuthorization.wallet, experienceId: track.protectedMedia.experienceId, mediaType: track.protectedMedia.mediaType || "AUDIO", authHeaders: this.mediaAuthorization.authHeaders })
        .then((grant) => { this.mediaGrants.set(key, grant); this.grantedKeys.add(key); return grant; })
        .finally(() => this.mediaRequests.delete(key));
      this.mediaRequests.set(key, request);
    }
    const grant = await this.mediaRequests.get(key);
    return grant.accessUrl;
  },

  // Play a track whose protected source was already authorized elsewhere
  // (e.g. the experience page's unlock), through the one shared player.
  playGranted(track, grant, queueId, queueLabel = null) {
    const key = grantKey(track);
    this.mediaGrants.set(key, grant);
    this.grantedKeys.add(key);
    this.setQueue([track], queueId, queueLabel);
    return this.play(0);
  },

  // Swap the element onto a newly authorized source, keeping position and state.
  swapSource(audio, source) {
    const wasPlaying = !audio.paused;
    const time = audio.currentTime || 0;
    audio.src = source;
    this.applyMasterVolume(audio);
    const resume = () => {
      try { audio.currentTime = Math.min(time, audio.duration || time); } catch { /* Metadata may not be available yet. */ }
      if (wasPlaying) audio.play().catch(() => {});
    };
    audio.addEventListener("loadedmetadata", resume, { once: true });
    this.notify();
  },

  // The element failed on the current track. A bearer stream whose grant has
  // lapsed (a long track outlives the grant TTL, or playback resumed after a
  // pause) is renewed once and resumed where it stopped; anything else is
  // reported for the UI, never hidden behind the public preview.
  async handleElementError() {
    const audio = this.el;
    const track = this.queue?.[this.idx];
    const code = audio?.error?.code ?? null;
    if (track?.protectedMedia && this.grantedKeys.has(grantKey(track)) && this.mediaAuthorization?.wallet) {
      const key = grantKey(track);
      const last = this.renewals.get(key) || 0;
      if (Date.now() - last > 10_000) {
        this.renewals.set(key, Date.now());
        this.mediaGrants.delete(key);
        try {
          const source = await this.resolveProtectedSource(track);
          if (source && this.queue?.[this.idx] === track) {
            this.lastError = null;
            this.swapSource(audio, source);
            return;
          }
        } catch (error) {
          this.lastError = { track, code, message: error?.message || playbackErrorMessage(code) };
          this.notify();
          return;
        }
      }
    }
    this.lastError = { track, code, message: playbackErrorMessage(code) };
    this.notify();
  },

  setOwnership(tokenIds) {
    this.owned = new Set((tokenIds || []).map((tokenId) => String(tokenId)));
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
    audio.addEventListener("play", () => { this.playing = true; this.lastError = null; this.notify(); });
    audio.addEventListener("error", () => { void this.handleElementError(); });
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
    this.lastError = null;
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
    if (this.canRequestGrant(track)) {
      void this.resolveProtectedSource(track).then((authorizedSource) => {
        if (!authorizedSource || this.queue?.[this.idx] !== track) return;
        const currentSource = audio.getAttribute("src") || audio.src || "";
        if (currentSource.endsWith(authorizedSource.split("/").pop())) return;
        this.swapSource(audio, authorizedSource);
      }).catch(() => this.notify());
    }
  },

  async play(index) {
    const track = this.queue?.[typeof index === "number" ? index : this.idx];
    if (track?.protectedMedia && (this.isProtectedHolder(track) || this.grantedKeys.has(grantKey(track)))) {
      if (!this.hasAuthorizedSource(track)) {
        if (!this.mediaAuthorization?.wallet) throw new Error("Authenticate the holder wallet before playing protected media.");
        await this.resolveProtectedSource(track);
      }
    }
    if (typeof index === "number") this.setTrack(index);
    else {
      this.ensure();
      if (!this.el.src) this.setTrack(this.idx);
      else if (track?.protectedMedia) {
        // Resuming after the grant lapsed: move onto the renewed grant in place.
        const source = this.srcFor(track);
        const current = this.el.getAttribute("src") || this.el.src || "";
        if (source && !current.endsWith(source.split("/").pop())) this.swapSource(this.el, source);
      }
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
