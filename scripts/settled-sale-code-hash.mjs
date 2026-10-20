// Derives the reviewed-runtime profile of VoidPrimarySaleSettled from the Foundry artifact:
// the byte ranges of its two immutables (releases, platformRecipient) and the keccak256 of the
// runtime code with those ranges zeroed and the Solidity metadata trailer removed.
// src/lib/sale-authorization.js commits the same values; a vitest asserts they agree.
//   node scripts/settled-sale-code-hash.mjs        # prints the profile as JSON
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maskedRuntimeHash } from "../src/lib/sale-authorization.js";

export const SETTLED_ARTIFACT_PATH = "out/VoidPrimarySaleSettled.sol/VoidPrimarySaleSettled.json";

export function immutableRanges(artifact) {
  const refs = artifact.deployedBytecode.immutableReferences || {};
  return Object.values(refs).flat().map(({ start, length }) => [start, length]).sort((a, b) => a[0] - b[0]);
}

export async function settledProfile(root = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  const artifact = JSON.parse(await readFile(resolve(root, SETTLED_ARTIFACT_PATH), "utf8"));
  const ranges = immutableRanges(artifact);
  return { ranges, hash: maskedRuntimeHash(artifact.deployedBytecode.object, ranges), runtimeBytes: (artifact.deployedBytecode.object.length - 2) / 2 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await settledProfile(), null, 2));
}
