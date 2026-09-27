import { describe, expect, it, vi } from "vitest";
import { IDLE_REVIEWER_STATE, createReviewerNotificationStore } from "./reviewer-notifications.js";

const REVIEWER = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA";
const NORMAL = "0xd1b4367dd9f235f9ee61878019d66e31511e98ee";

function forbidden() {
  return Object.assign(new Error("Not a reviewer."), { code: "REVIEWER_REQUIRED", status: 403 });
}

function fakes({ reviewers = [REVIEWER.toLowerCase()], counts = {} } = {}) {
  const fetchMe = vi.fn(async ({ headers }) => ({ application: null, canReapply: true, reviewer: reviewers.includes(headers.wallet) }));
  const fetchCount = vi.fn(async ({ headers }) => {
    if (!reviewers.includes(headers.wallet)) throw forbidden();
    return { count: counts[headers.wallet] ?? 0 };
  });
  return { fetchMe, fetchCount };
}

// Test doubles pass the wallet through `headers` so the fakes can tell
// sessions apart; the real client only ever sends the authorization header.
function session(wallet, token = "tok") {
  return { ready: true, wallet, headers: { authorization: `Bearer ${token}`, wallet: wallet.toLowerCase() } };
}

describe("reviewer notification store", () => {
  it("starts idle: no reviewer, no count", () => {
    const store = createReviewerNotificationStore(fakes());
    expect(store.getState()).toBe(IDLE_REVIEWER_STATE);
  });

  it("marks an authorized reviewer wallet and loads its pending-review count from the server", async () => {
    const f = fakes({ counts: { [REVIEWER.toLowerCase()]: 3 } });
    const store = createReviewerNotificationStore(f);
    const seen = [];
    store.subscribe(() => seen.push(store.getState()));
    await store.sync(session(REVIEWER));
    expect(store.getState()).toMatchObject({ wallet: REVIEWER.toLowerCase(), reviewer: true, count: 3, loading: false, error: null });
    expect(seen[0]).toMatchObject({ loading: true, reviewer: false, count: null });
    expect(f.fetchMe).toHaveBeenCalledTimes(1);
    expect(f.fetchCount).toHaveBeenCalledTimes(1);
  });

  it("never asks for the count on behalf of a normal wallet", async () => {
    const f = fakes();
    const store = createReviewerNotificationStore(f);
    await store.sync(session(NORMAL));
    expect(store.getState()).toMatchObject({ wallet: NORMAL, reviewer: false, count: null, loading: false });
    expect(f.fetchCount).not.toHaveBeenCalled();
  });

  it("treats a failed reviewer lookup as not-a-reviewer", async () => {
    const store = createReviewerNotificationStore({ fetchMe: vi.fn().mockRejectedValue(new Error("offline")), fetchCount: vi.fn() });
    await store.sync(session(REVIEWER));
    expect(store.getState()).toMatchObject({ reviewer: false, count: null });
  });

  it("drops the reviewer UI if the count endpoint answers REVIEWER_REQUIRED", async () => {
    const store = createReviewerNotificationStore({
      fetchMe: vi.fn().mockResolvedValue({ reviewer: true }),
      fetchCount: vi.fn().mockRejectedValue(forbidden()),
    });
    await store.sync(session(REVIEWER));
    expect(store.getState()).toMatchObject({ reviewer: false, count: null });
  });

  it("clears everything, including the previous count, when the wallet disconnects", async () => {
    const f = fakes({ counts: { [REVIEWER.toLowerCase()]: 5 } });
    const store = createReviewerNotificationStore(f);
    await store.sync(session(REVIEWER));
    expect(store.getState().count).toBe(5);
    await store.sync({ ready: false, wallet: null, headers: {} });
    expect(store.getState()).toBe(IDLE_REVIEWER_STATE);
  });

  it("clears when the wallet loses authentication even while still connected", async () => {
    const f = fakes({ counts: { [REVIEWER.toLowerCase()]: 5 } });
    const store = createReviewerNotificationStore(f);
    await store.sync(session(REVIEWER));
    await store.sync({ ready: false, wallet: REVIEWER, headers: {} });
    expect(store.getState()).toBe(IDLE_REVIEWER_STATE);
  });

  it("re-evaluates from scratch when the wallet changes and does not carry the old count over", async () => {
    const f = fakes({ counts: { [REVIEWER.toLowerCase()]: 4 } });
    const store = createReviewerNotificationStore(f);
    await store.sync(session(REVIEWER));
    const seen = [];
    store.subscribe(() => seen.push(store.getState()));
    await store.sync(session(NORMAL));
    expect(seen.every((s) => s.count === null && s.reviewer === false)).toBe(true);
    expect(store.getState()).toMatchObject({ wallet: NORMAL, reviewer: false, count: null });
    expect(f.fetchMe).toHaveBeenCalledTimes(2);
  });

  it("does not refetch when synced again with the same wallet and session", async () => {
    const f = fakes();
    const store = createReviewerNotificationStore(f);
    await store.sync(session(REVIEWER));
    await store.sync(session(REVIEWER));
    expect(f.fetchMe).toHaveBeenCalledTimes(1);
    expect(f.fetchCount).toHaveBeenCalledTimes(1);
  });

  it("refresh re-reads the count after a reviewer action", async () => {
    const counts = { [REVIEWER.toLowerCase()]: 2 };
    const f = fakes({ counts });
    const store = createReviewerNotificationStore(f);
    await store.sync(session(REVIEWER));
    expect(store.getState().count).toBe(2);
    counts[REVIEWER.toLowerCase()] = 1; // e.g. one application approved
    await store.refresh();
    expect(store.getState().count).toBe(1);
    expect(f.fetchMe).toHaveBeenCalledTimes(1);
    expect(f.fetchCount).toHaveBeenCalledTimes(2);
  });

  it("refresh is a no-op for non-reviewers and disconnected wallets", async () => {
    const f = fakes();
    const store = createReviewerNotificationStore(f);
    await store.refresh();
    await store.sync(session(NORMAL));
    await store.refresh();
    expect(f.fetchCount).not.toHaveBeenCalled();
  });

  it("ignores a late reviewer response that arrives after the wallet disconnected", async () => {
    let release;
    const fetchMe = vi.fn(() => new Promise((resolve) => { release = () => resolve({ reviewer: true }); }));
    const fetchCount = vi.fn().mockResolvedValue({ count: 9 });
    const store = createReviewerNotificationStore({ fetchMe, fetchCount });
    const pending = store.sync(session(REVIEWER));
    await store.sync({ ready: false });
    release();
    await pending;
    expect(store.getState()).toBe(IDLE_REVIEWER_STATE);
    expect(fetchCount).not.toHaveBeenCalled();
  });

  it("keeps the last good count and records the error when a refresh fails", async () => {
    const fetchCount = vi.fn().mockResolvedValueOnce({ count: 2 }).mockRejectedValueOnce(new Error("timeout"));
    const store = createReviewerNotificationStore({ fetchMe: vi.fn().mockResolvedValue({ reviewer: true }), fetchCount });
    await store.sync(session(REVIEWER));
    await store.refresh();
    expect(store.getState()).toMatchObject({ reviewer: true, count: 2, error: "timeout" });
  });
});
