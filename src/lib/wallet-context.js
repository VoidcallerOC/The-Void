import { createContext, useContext } from "react";

export const WalletCtx = createContext(null);

export function useWallet() {
  return useContext(WalletCtx);
}
