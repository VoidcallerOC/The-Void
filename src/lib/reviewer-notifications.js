import { fetchMyApplication, fetchReviewCount } from "./verification-api.js";

// Header notification state for artist-verification reviewers.
//
// Framework-free so it can be unit tested without a DOM. The React provider
// (ReviewerNotificationsProvider.jsx) feeds it wallet/auth changes through
// sync() and subscribes to it with useSyncExternalStore.
//
// Reviewer status comes from the server (GET /verification/me → reviewer),
// and the badge number from the reviewer-only count endpoint. Nothing here
// decides who is a reviewer; a non-reviewer wallet simply never asks for the
// count.

export const IDLE_REVIEWER_STATE = Object.freeze({
  wallet: null,
  reviewer: false,
  count: null,
  loading: false,
  error: null,
});

function normalizeWallet(wallet) {
  return typeof wallet === "string" && wallet ? wallet.toLowerCase() : null;
}

export function createReviewerNotificationStore({ fetchMe = fetchMyApplication, fetchCount = fetchReviewCount } = {}) {
  let state = IDLE_REVIEWER_STATE;
  let session = null; // { wallet, headers } for the currently synced reviewer session
  let generation = 0; // bumps on every sync/clear so stale responses are dropped
  const listeners = new Set();

  function emit(next) {
    state = next;
    for (const listener of listeners) listener();
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getState() {
    return state;
  }

  // Forget everything about the previous wallet. Called on disconnect, on
  // account change, and when authentication is lost, so a stale count is
  // never shown for the wrong wallet.
  function clear() {
    session = null;
    generation += 1;
    if (state !== IDLE_REVIEWER_STATE) emit(IDLE_REVIEWER_STATE);
  }

  async function loadCount(current, token) {
    try {
      const result = await fetchCount({ headers: current.headers });
      if (token !== generation) return;
      emit({ wallet: current.wallet, reviewer: true, count: Math.max(0, Number(result?.count) || 0), loading: false, error: null });
    } catch (error) {
      if (token !== generation) return;
      if (error?.status === 403 || error?.code === "REVIEWER_REQUIRED") {
        // Authorization was revoked between detection and count: drop the UI.
        emit({ ...IDLE_REVIEWER_STATE, wallet: current.wallet });
        return;
      }
      emit({ wallet: current.wallet, reviewer: true, count: state.reviewer && state.wallet === current.wallet ? state.count : null, loading: false, error: error?.message || "Review count unavailable." });
    }
  }

  async function detect(current, token) {
    emit({ ...IDLE_REVIEWER_STATE, wallet: current.wallet, loading: true });
    let reviewer;
    try {
      const me = await fetchMe({ headers: current.headers });
      reviewer = Boolean(me?.reviewer);
    } catch {
      reviewer = false;
    }
    if (token !== generation) return;
    if (!reviewer) {
      emit({ ...IDLE_REVIEWER_STATE, wallet: current.wallet });
      return;
    }
    await loadCount(current, token);
  }

  // Called whenever wallet/auth state changes. `ready` means the wallet is
  // connected AND has an authenticated session; anything less clears the UI.
  function sync({ ready = false, wallet = null, headers = {} } = {}) {
    const normalized = normalizeWallet(wallet);
    if (!ready || !normalized) {
      clear();
      return Promise.resolve();
    }
    const authorization = headers?.authorization || null;
    if (session && session.wallet === normalized && session.authorization === authorization) return Promise.resolve();
    session = { wallet: normalized, headers, authorization };
    generation += 1;
    return detect(session, generation);
  }

  // Re-read the count for the current reviewer session (after a reviewer
  // action, or on returning to the queue). No-op for non-reviewers.
  function refresh() {
    if (!session || !state.reviewer || state.wallet !== session.wallet) return Promise.resolve();
    return loadCount(session, generation);
  }

  return { subscribe, getState, sync, refresh, clear };
}
