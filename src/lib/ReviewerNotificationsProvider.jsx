import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useWallet } from "./wallet-context.js";
import { ReviewerNotificationsCtx } from "./reviewer-notifications-context.js";
import { createReviewerNotificationStore } from "./reviewer-notifications.js";
import { authorizationHeaders } from "./wallet-auth.js";

// Bridges the wallet/auth state into the reviewer notification store and
// exposes { reviewer, count, loading, error, refresh } to the header and the
// review pages. Must sit inside WalletProvider.
export function ReviewerNotificationsProvider({ children, store: injectedStore = null }) {
  const [store] = useState(() => injectedStore || createReviewerNotificationStore());
  const wallet = useWallet();
  const account = wallet?.account || null;
  const sessionToken = wallet?.authSession?.token || null;
  const ready = Boolean(wallet?.connected && wallet?.authenticated && sessionToken);

  // Re-sync only when the identity actually changes (account or session
  // token), not on every provider re-render. Losing auth or the account
  // clears the store immediately, so no stale count survives a disconnect.
  useEffect(() => {
    void store.sync({ ready, wallet: account, headers: authorizationHeaders({ token: sessionToken }) });
  }, [store, ready, account, sessionToken]);

  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const refresh = useCallback(() => store.refresh(), [store]);
  const value = useMemo(() => ({ ...state, refresh }), [state, refresh]);

  return <ReviewerNotificationsCtx.Provider value={value}>{children}</ReviewerNotificationsCtx.Provider>;
}
