// The on-chain tag (ERC-1155 symbol) of a release contract. The server enforces
// /^[A-Z0-9]{1,11}$/ (server/studio-service.js contractSymbolInput); this is the same
// rule for the Studio field. It is editable only until the contract exists on-chain.

export const CONTRACT_SYMBOL_MAX = 11;

export function normalizeContractSymbol(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CONTRACT_SYMBOL_MAX);
}

/**
 * What the symbol field should do for the current Studio state.
 * - locked: only once the release contract is confirmed on-chain; then `displayed`
 *   is the symbol read from the deployed contract, never the draft value.
 * - stale: a prepared request exists for a different symbol, so it must not be
 *   used to create the release until it is re-prepared.
 */
export function symbolFieldState({ input = "", provisioning = null, provisioningState = "NOT_STARTED", onChainSymbol = "" } = {}) {
  const typed = normalizeContractSymbol(input);
  const locked = provisioningState === "CONFIRMED";
  if (locked) return { locked: true, stale: false, displayed: normalizeContractSymbol(onChainSymbol) || normalizeContractSymbol(provisioning?.symbol), effective: null };
  const prepared = normalizeContractSymbol(provisioning?.symbol);
  return { locked: false, stale: Boolean(provisioning && typed && typed !== prepared), displayed: typed, effective: typed || prepared || null };
}

/** True only when a fresh preparation is byte-for-byte the one the artist reviewed. */
export function preparedParametersAreCurrent(shown, fresh) {
  const a = String(shown?.authorizationDigest || "").toLowerCase();
  return Boolean(a) && a === String(fresh?.authorizationDigest || "").toLowerCase();
}
