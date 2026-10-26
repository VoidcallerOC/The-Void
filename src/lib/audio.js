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

// Source identity is the full normalized URL (origin + path), never just the
// filename: two hosts can serve the same file name and still be different media.
function locationOrigin() {
  try { return typeof window !== "undefined" && window.location?.origin && window.location.origin !== "null" ? window.location.origin : "http://localhost"; } catch { return "http://localhost"; }
}
export function sourceIdentity(source) {
  if (!source) return "";
  try { const url = new URL(String(source), locationOrigin()); return `${url.origin}${url.pathname}`; } catch { return String(source); }
}
export function sameSource(left, right) {
  const a = sourceIdentity(left);
  return Boolean(a) && a === sourceIdentity(right);
}
function sourceHost(source) {
  if (!source) return null;
  try { return new URL(String(source), locationOrigin()).hostname || null; } catch { return null; }
}

// Opt-in playback diagnostics (?audioDebug=1). A bounded, in-memory ring of
// event names, element state numbers, the source category, and the hostname.
// Full URLs, paths, query strings, wallets, grant IDs, and credentials are
// never recorded, and nothing is sent anywhere.
export const AUDIO_DEBUG_LIMIT = 100;
const DIAGNOSTIC_FIELDS = ["category", "host", "reused", "code", "networkState", "readyState", "name", "detail"];
export function audioDebugRequested(search) {
  try {
    const query = search ?? (typeof window !== "undefined" ? window.location?.search : "");
    return new URLSearchParams(query || "").get("audioDebug") === "1";
  } catch {
    return false;
  }
}
function safeDiagnosticValue(key, value) {
  if (value == null) return undefined;
  if (key === "reused") return Boolean(value);
  if (key === "code" || key === "networkState" || key === "readyState") return Number.isFinite(Number(value)) ? Number(value) : undefined;
  if (key === "category") return ["preview", "protected", "other", "none"].includes(value) ? value : "other";
  if (key === "host") return /^[a-z0-9.-]+$/i.test(String(value)) ? String(value).slice(0, 253) : undefined;
  // Error names and fixed detail labels only; anything URL- or hex-like is dropped.
  const text = String(value).slice(0, 40);
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(text) && !/0x[0-9a-f]/i.test(text) ? text : undefined;
}

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
  // Bumped on every track, queue, or wallet change so a late async grant
  // response cannot overwrite the playback that replaced it.
  generation: 0,
  authEpoch: 0,
  // Protected renewals in the current playback attempt (max 2). Reset only by
  // an explicit play() call or a track change, never by media events.
  renewalAttempts: new Map(),
  maxRenewalAttempts: 2,
  // iOS may refuse play() after an awaited grant (the gesture expired): the
  // UI shows a tap-to-play state instead of failing silently.
  needsGesture: false,
  diagnostics: { enabled: audioDebugRequested(), events: [] },

  setDiagnosticsEnabled(enabled) {
    this.diagnostics.enabled = Boolean(enabled);
    if (!this.diagnostics.enabled) this.diagnostics.events = [];
    this.notify();
  },

  sourceCategory(track, source) {
    if (!source) return "none";
    const grant = track?.protectedMedia ? this.mediaGrants.get(grantKey(track)) : null;
    if (grant?.accessUrl && sameSource(grant.accessUrl, source)) return "protected";
    if (track?.previewSrc && sameSource(track.previewSrc, source)) return "preview";
    if (track?.preview && track?.src && sameSource(track.src, source)) return "preview";
    return "other";
  },

  record(type, data = {}, audio = this.el) {
    if (!this.diagnostics.enabled) return;
    const event = { t: Date.now(), type: safeDiagnosticValue("detail", type) || "event" };
    if (audio) { event.networkState = audio.networkState; event.readyState = audio.readyState; }
    for (const key of DIAGNOSTIC_FIELDS) {
      const value = safeDiagnosticValue(key, key in data ? data[key] : event[key]);
      if (value === undefined) delete event[key]; else event[key] = value;
    }
    const events = this.diagnostics.events;
    events.push(event);
    if (events.length > AUDIO_DEBUG_LIMIT) events.splice(0, events.length - AUDIO_DEBUG_LIMIT);
  },

  recordSource(type, track, source, extra = {}) {
    this.record(type, { category: this.sourceCategory(track, source), host: sourceHost(source), ...extra });
  },

  diagnosticsText() {
    return JSON.stringify({ events: this.diagnostics.events }, null, 2);
  },

  // Load `source` on the element. The same source is reused unless the element
  // is in a failed state, in which case it is reset and reloaded so a retry
  // never replays the failed element as-is.
  loadSource(audio, track, source) {
    const current = audio.getAttribute("src") || audio.src || "";
    if (sameSource(current, source) && !audio.error) {
      this.recordSource("source-reused", track, source, { reused: true });
      return false;
    }
    if (current && audio.error) {
      audio.removeAttribute("src");
      audio.load();
    }
    audio.src = source;
    this.recordSource(current && sameSource(current, source) ? "source-reset" : "source-select", track, source, { reused: false });
    return true;
  },

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
  // `owned` holds only Genesis-range token IDs (RELIC_TOKEN_IDS) of the Genesis collections. A factory release
  // token numbered like one of them is a different asset (release token 1 is not Genesis token 1), so its
  // number alone never makes the wallet its holder.
  ownsTrackToken(track) {
    if (track?.tokenId == null) return false;
    if (track.releaseToken && RELIC_TOKEN_IDS.some((id) => String(id) === String(track.tokenId))) return false;
    return this.owned.has(String(track.tokenId));
  },
  isProtectedHolder(track) {
    return Boolean(track?.protectedMedia && (this.holdsChapterI() || this.ownsTrackToken(track)));
  },

  setMediaAuthorization({ wallet = null, authHeaders = {} } = {}) {
    const normalizedWallet = wallet?.toLowerCase() || null;
    if (normalizedWallet !== this.mediaAuthorization?.wallet) { this.mediaGrants.clear(); this.grantedKeys.clear(); this.mediaRequests.clear(); this.authEpoch += 1; this.generation += 1; }
    this.mediaAuthorization = normalizedWallet ? { wallet: normalizedWallet, authHeaders } : null;
    this.notify();
  },

  async revokeMediaGrants() {
    const authorization = this.mediaAuthorization;
    const grants = [...this.mediaGrants.values()];
    this.mediaGrants.clear();
    this.mediaRequests.clear();
    this.grantedKeys.clear();
    this.authEpoch += 1;
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
    if (!track.releaseToken && track.tokenId != null && RELIC_TOKEN_IDS.includes(track.tokenId)) return !!(track.previewSrc && !this.holdsChapterI());
    return !!(track.previewSrc && track.tokenId != null && !this.ownsTrackToken(track));
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
      const epoch = this.authEpoch;
      this.record("grant-request", { category: "protected" });
      const request = requestProtectedMediaGrant({ wallet: this.mediaAuthorization.wallet, experienceId: track.protectedMedia.experienceId, mediaType: track.protectedMedia.mediaType || "AUDIO", authHeaders: this.mediaAuthorization.authHeaders })
        .then((grant) => {
          // A grant issued for a wallet session that has since changed is dropped.
          if (epoch !== this.authEpoch) { this.record("grant-stale", { category: "protected" }); return null; }
          this.mediaGrants.set(key, grant); this.grantedKeys.add(key); return grant;
        })
        .finally(() => { if (this.mediaRequests.get(key) === request) this.mediaRequests.delete(key); });
      this.mediaRequests.set(key, request);
    }
    const grant = await this.mediaRequests.get(key);
    return grant?.accessUrl || null;
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
  swapSource(audio, source, track = this.queue?.[this.idx]) {
    const wasPlaying = !audio.paused;
    const time = audio.currentTime || 0;
    if (audio.error) { audio.removeAttribute("src"); audio.load(); }
    audio.src = source;
    this.recordSource("source-swap", track, source, { reused: false });
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
    const current = audio ? (audio.getAttribute("src") || audio.src || "") : "";
    const category = this.sourceCategory(track, current);
    this.record("media-error", { category, host: sourceHost(current), code });
    // Only a failing protected grant source is renewed; a preview or other
    // source error never requests a protected-media grant.
    if (category === "protected" && track?.protectedMedia && this.grantedKeys.has(grantKey(track)) && this.mediaAuthorization?.wallet) {
      const key = grantKey(track);
      const last = this.renewals.get(key) || 0;
      const attempts = this.renewalAttempts.get(key) || 0;
      if (Date.now() - last > 10_000 && attempts < this.maxRenewalAttempts) {
        this.renewals.set(key, Date.now());
        this.renewalAttempts.set(key, attempts + 1);
        this.mediaGrants.delete(key);
        const generation = this.generation;
        this.record("grant-renew", { category: "protected" });
        try {
          const source = await this.resolveProtectedSource(track);
          if (generation !== this.generation || this.queue?.[this.idx] !== track) return;
          if (source) {
            this.lastError = null;
            this.swapSource(audio, source, track);
            return;
          }
        } catch (error) {
          if (generation !== this.generation) return;
          this.lastError = { track, code, kind: "media", message: error?.message || playbackErrorMessage(code) };
          this.notify();
          return;
        }
      }
    }
    this.lastError = { track, code, kind: "media", message: playbackErrorMessage(code) };
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
    audio.addEventListener("play", () => { this.playing = true; this.lastError = null; this.needsGesture = false; this.notify(); });
    audio.addEventListener("error", () => { void this.handleElementError(); });
    audio.addEventListener("pause", () => { this.playing = false; this.notify(); });
    // Metadata loading never resets the renewal cap (a source that loads and
    // then keeps failing must not renew forever).
    audio.addEventListener("loadedmetadata", () => { this.record("loadedmetadata"); this.notify(); });
    for (const name of ["stalled", "abort", "emptied"]) audio.addEventListener(name, () => this.record(name));
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
    this.needsGesture = false;
    this.generation += 1;
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
    if (index !== this.idx) { this.lastError = null; this.needsGesture = false; this.renewalAttempts.clear(); }
    this.idx = index;
    this.generation += 1;
    const generation = this.generation;
    const source = this.srcFor(track);
    const current = audio.getAttribute("src") || audio.src || "";
    if (source) this.loadSource(audio, track, source);
    else if (current) {
      audio.removeAttribute("src");
      audio.load();
      this.record("source-cleared", { category: "none" });
    }
    this.applyMasterVolume(audio);
    if (this.canRequestGrant(track)) {
      void this.resolveProtectedSource(track).then((authorizedSource) => {
        // Ignore a grant that lands after the track, queue, or wallet changed.
        if (!authorizedSource || generation !== this.generation || this.queue?.[this.idx] !== track) return;
        const currentSource = audio.getAttribute("src") || audio.src || "";
        if (sameSource(currentSource, authorizedSource) && !audio.error) return;
        this.swapSource(audio, authorizedSource, track);
      }).catch(() => this.notify());
    }
  },

  async play(index) {
    const track = this.queue?.[typeof index === "number" ? index : this.idx];
    const generation = this.generation;
    // An explicit play() call is a new playback attempt: it gets a fresh renewal budget.
    this.renewalAttempts.clear();
    this.record("play-attempt", { category: track?.protectedMedia ? "protected" : (track?.preview ? "preview" : "other") });
    if (track?.protectedMedia && (this.isProtectedHolder(track) || this.grantedKeys.has(grantKey(track)))) {
      if (!this.hasAuthorizedSource(track)) {
        if (!this.mediaAuthorization?.wallet) throw new Error("Authenticate the holder wallet before playing protected media.");
        await this.resolveProtectedSource(track);
        // The track, queue, or wallet changed while the grant was pending:
        // the newer playback wins and nothing protected starts here.
        if (generation !== this.generation || !this.hasAuthorizedSource(track)) { this.record("play-superseded"); return; }
      }
    }
    if (typeof index === "number") this.setTrack(index);
    else {
      this.ensure();
      if (!this.el.src) this.setTrack(this.idx);
      else if (track) {
        // Resuming: move onto a renewed grant in place, or reload a failed source.
        const source = this.srcFor(track);
        const current = this.el.getAttribute("src") || this.el.src || "";
        if (source && (!sameSource(current, source) || this.el.error)) {
          if (track.protectedMedia && !sameSource(current, source)) this.swapSource(this.el, source, track);
          else this.loadSource(this.el, track, source);
        }
      }
    }
    this.applyMasterVolume();
    return this.el.play().catch((error) => {
      const name = error?.name || "Error";
      this.record("play-rejected", { name });
      if (name === "NotAllowedError") {
        // Autoplay policy (iOS after an awaited grant): a second tap is needed.
        this.needsGesture = true;
        this.lastError = { track: this.queue?.[this.idx], code: null, kind: "gesture", message: "Tap play to start playback." };
      }
      this.notify();
      throw error;
    });
  },

  pause() { if (this.el) this.el.pause(); },
  toggle() { this.ensure(); if (this.el.paused) this.play().catch(() => {}); else this.pause(); },
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
