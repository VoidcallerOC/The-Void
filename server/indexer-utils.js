export const zeroAddress = "0x0000000000000000000000000000000000000000";

export function normalizeBlockTimestamp(value) {
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("Block timestamp is invalid.");
  return new Date(seconds * 1000);
}

export function retry(operation, { retries = 4, baseDelayMs = 20, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onRetry = () => {} } = {}) {
  return (async () => {
    let attempt = 0;
    while (true) {
      try { return await operation(); } catch (error) {
        if (attempt >= retries) throw error;
        const delay = baseDelayMs * (2 ** attempt);
        attempt += 1;
        onRetry({ attempt, delay, error });
        await sleep(delay);
      }
    }
  })();
}
