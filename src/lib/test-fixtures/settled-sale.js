import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";

// Test-only: the reviewed VoidPrimarySaleSettled runtime, built from the Foundry artifact with
// both immutables filled in exactly as a deployment would. Tests that need it skip when the
// artifact (out/) has not been built.
// Resolved from the working directory (vitest runs at the repo root): under jsdom import.meta.url is not a file: URL.
export const SETTLED_ARTIFACT_URL = resolve(globalThis.process.cwd(), "out/VoidPrimarySaleSettled.sol/VoidPrimarySaleSettled.json");
export const haveSettledArtifact = existsSync(SETTLED_ARTIFACT_URL);

export function settledRuntime({ release, platform }) {
  const artifact = JSON.parse(readFileSync(SETTLED_ARTIFACT_URL, "utf8"));
  const bytes = ethers.getBytes(artifact.deployedBytecode.object);
  // The immutable declared first (lower AST id) is `releases`; the second is `platformRecipient`.
  const ids = Object.keys(artifact.deployedBytecode.immutableReferences).sort((a, b) => Number(a) - Number(b));
  const values = [release, platform];
  ids.forEach((id, index) => {
    for (const { start, length } of artifact.deployedBytecode.immutableReferences[id]) bytes.set(ethers.getBytes(ethers.zeroPadValue(values[index], length)), start);
  });
  return ethers.hexlify(bytes);
}
