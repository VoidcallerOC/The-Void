import { ethers } from "ethers";
import { anchorsProvenanceAtCreation, releaseDeploymentForFactory } from "../../config/release-network.js";

// D3 lifecycle: one release contract is either standalone (editions via createEdition) or an album
// (tracks via createAlbumTrack) for its whole life. An album that reuses earlier music is a new
// release contract; it is never blocked by this module.
//
// VoidRelease1155V5 enforces this on-chain: createAlbum reverts StandaloneEditionsExist once
// hasStandaloneEditions() is true. VoidRelease1155V4 and older clones are immutable and have no such
// guard, so these reads are an application-level check only: a direct wallet call to createAlbum on
// a V4 clone is not prevented.

export const STANDALONE_EDITIONS_EXIST_MESSAGE = "This release contract already has standalone editions, so it cannot become an Album Contract. Those editions stay exactly as released. To put this music on an album, create a new Album release and add the single to it.";
export const ALBUM_TYPE_LOCKED_MESSAGE = "This release's Album Contract is already active on-chain, so the release type stays Album. Create a new release for a single or EP.";
export const RELEASE_CHAIN_STATE_UNAVAILABLE_MESSAGE = "The release contract's on-chain state could not be read, so nothing was changed. Try again.";

const lifecycleIface = new ethers.Interface([
  "function albumCreated() view returns (bool)",
  "function hasStandaloneEditions() view returns (bool)",
  "function maxSupplyOf(uint256 tokenId) view returns (uint256)",
  "error EditionNotFound(uint256 tokenId)",
]);
const EDITION_NOT_FOUND_SELECTOR = lifecycleIface.getError("EditionNotFound").selector;

/** Matches the server's generatedSlug and the edition IDs Studio publishes with. */
export function editionSlugFromTitle(title) {
  return String(title || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31).replace(/-+$/g, "");
}

/** Token ID of a release-clone edition; the same derivation as VoidRelease1155V4/V5 tokenIdFor. */
export function releaseEditionTokenId(editionSlug) {
  const editionId = ethers.encodeBytes32String(editionSlug);
  const tokenId = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["the-void:release-edition:v1", editionId])));
  return tokenId === 0n ? 1n : tokenId;
}

function revertDataOf(error) {
  for (const candidate of [error?.data, error?.error?.data, error?.info?.error?.data, error?.data?.data]) {
    if (typeof candidate === "string" && /^0x[0-9a-f]*$/i.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Which lifecycle getters a release clone must answer, from trusted deployment metadata, never from
 * an error: a failed or rate-limited eth_call is not evidence that a getter is missing. Version 3+
 * clones are VoidRelease1155V5 and have both getters. Version 2 clones take album support from the
 * recorded factory (V4 album-capable, or the pre-album implementation); V4 has no
 * hasStandaloneEditions(). Returns null when the deployment is not recognised, so callers fail closed.
 */
export function lifecycleExpectations({ implementationVersion, factoryAddress }) {
  const version = Number(implementationVersion);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  if (anchorsProvenanceAtCreation(version)) return Object.freeze({ albumCreated: true, hasStandaloneEditions: true });
  const deployment = releaseDeploymentForFactory(factoryAddress);
  if (!deployment || Number(deployment.releaseVersion) !== version) return null;
  return Object.freeze({ albumCreated: deployment.albumCapable === true, hasStandaloneEditions: false });
}

/** Expectations for a release clone known only by its factory (Studio): the recorded factory's version. */
export function lifecycleExpectationsForFactory(factoryAddress) {
  return lifecycleExpectations({ factoryAddress, implementationVersion: releaseDeploymentForFactory(factoryAddress)?.releaseVersion });
}

/**
 * Reads the lifecycle state of a release clone with EIP-1193 style eth_call requests.
 * `request` is `async ({ method, params }) => result`. `expect` (from lifecycleExpectations) says
 * which getters the clone has; an expected getter that errors or returns no data throws, so callers
 * fail closed. `tokenIds` are the canonical token IDs stored for the release's editions, checked for
 * on-chain existence because a mined edition can still be DRAFT in the database.
 */
export async function readReleaseLifecycle(request, releaseContractAddress, { tokenIds = [], expect } = {}) {
  if (!ethers.isAddress(releaseContractAddress) || ethers.getAddress(releaseContractAddress) === ethers.ZeroAddress) throw new Error("The release contract address is invalid.");
  if (!expect || typeof expect.albumCreated !== "boolean" || typeof expect.hasStandaloneEditions !== "boolean") throw new Error("The release contract's implementation is not recognised.");
  const to = ethers.getAddress(releaseContractAddress);
  const call = (data) => request({ method: "eth_call", params: [{ to, data }, "latest"] });
  const requiredBool = async (name) => {
    const result = await call(lifecycleIface.encodeFunctionData(name));
    if (typeof result !== "string" || result === "0x") throw new Error(`The release contract returned no data for ${name}().`);
    return Boolean(lifecycleIface.decodeFunctionResult(name, result)[0]);
  };
  const [albumCreated, standaloneFlag] = await Promise.all([
    expect.albumCreated ? requiredBool("albumCreated") : false,
    expect.hasStandaloneEditions ? requiredBool("hasStandaloneEditions") : null,
  ]);
  const existingTokenIds = [];
  for (const tokenId of tokenIds) {
    try {
      const result = await call(lifecycleIface.encodeFunctionData("maxSupplyOf", [BigInt(tokenId)]));
      if (typeof result !== "string" || result === "0x") throw new Error("The release contract returned no edition data.");
      existingTokenIds.push(BigInt(tokenId));
    } catch (error) {
      if (String(revertDataOf(error) || "").toLowerCase().startsWith(EDITION_NOT_FOUND_SELECTOR)) continue;
      throw error;
    }
  }
  return { albumCreated: albumCreated === true, standaloneFlag, existingTokenIds, hasEditions: standaloneFlag === true || existingTokenIds.length > 0 };
}

/** The D3 rule for a release-type change. Returns null when allowed. */
export function releaseTypeChangeBlocker({ toType, lifecycle }) {
  if (lifecycle.albumCreated && toType !== "ALBUM") return { code: "ALBUM_TYPE_LOCKED", message: ALBUM_TYPE_LOCKED_MESSAGE };
  if (toType === "ALBUM" && !lifecycle.albumCreated && lifecycle.hasEditions) return { code: "STANDALONE_EDITIONS_EXIST", message: STANDALONE_EDITIONS_EXIST_MESSAGE };
  return null;
}
