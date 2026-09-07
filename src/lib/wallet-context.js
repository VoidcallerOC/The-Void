import { createContext, useContext } from "react";

// Context + hook live in their own module (no component exports) so the
// provider file stays fast-refresh friendly.
export const WalletCtx = createContext(null);

export function useWallet() {
  return useContext(WalletCtx);
}
