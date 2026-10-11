import { ethers } from "ethers";

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

function isRevert(error) {
  return error?.code === "CALL_EXCEPTION" || revertDataOf(error) !== null || /execution reverted|revert/i.test(String(error?.message || error?.error?.message || ""));
}

/**
 * Reads the lifecycle state of a release clone with EIP-1193 style eth_call requests.
 * `request` is `async ({ method, params }) => result`. A revert or empty result on the album or
 * guard getters means the implementation lacks them; any transport failure throws, so callers
 * fail closed. `tokenIds` are the release's known editions, checked for on-chain existence because
 * a mined edition can still be DRAFT in the database.
 */
export async function readReleaseLifecycle(request, releaseContractAddress, { tokenIds = [] } = {}) {
  if (!ethers.isAddress(releaseContractAddress) || ethers.getAddress(releaseContractAddress) === ethers.ZeroAddress) throw new Error("The release contract address is invalid.");
  const to = ethers.getAddress(releaseContractAddress);
  const call = (data) => request({ method: "eth_call", params: [{ to, data }, "latest"] });
  const optionalBool = async (name) => {
    let result;
    try {
      result = await call(lifecycleIface.encodeFunctionData(name));
    } catch (error) {
      if (isRevert(error)) return null;
      throw error;
    }
    if (typeof result !== "string" || result === "0x") return null;
    return Boolean(lifecycleIface.decodeFunctionResult(name, result)[0]);
  };
  const [albumCreated, standaloneFlag] = await Promise.all([optionalBool("albumCreated"), optionalBool("hasStandaloneEditions")]);
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
