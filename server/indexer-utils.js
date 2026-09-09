export const zeroAddress = "0x0000000000000000000000000000000000000000";

export function normalizeBlockTimestamp(value) {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("Block timestamp is invalid.");
  return new Date(seconds * 1000);
}
