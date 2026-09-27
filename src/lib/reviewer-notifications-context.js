import { createContext, useContext } from "react";
import { IDLE_REVIEWER_STATE } from "./reviewer-notifications.js";

// Context + hook live apart from the provider component so the provider
// file stays fast-refresh friendly (same pattern as wallet-context.js).
export const ReviewerNotificationsCtx = createContext(null);

const NO_PROVIDER = Object.freeze({ ...IDLE_REVIEWER_STATE, refresh: () => Promise.resolve() });

// Safe outside the provider (e.g. isolated page renders): reads as "not a
// reviewer" with a no-op refresh, so callers never need to null-check.
export function useReviewerNotifications() {
  return useContext(ReviewerNotificationsCtx) || NO_PROVIDER;
}
