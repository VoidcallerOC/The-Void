import { ethers } from "ethers";
import { releaseDeploymentForFactory } from "../../config/release-network.js";

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
export const ALBUM_NOT_SUPPORTED_MESSAGE = "This release contract was deployed from the pre-album implementation and can never become an Album Contract. Create a new Album release instead.";
export const CURRENT_EDITIONS_UNAVAILABLE_MESSAGE = "The release's current editions could not be read, so nothing was changed. Try again.";
export const CATALOG_REFRESH_TIMEOUT_MS = 15_000;
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

// Lifecycle getters per known release implementation, keyed by the factory's ReleaseCreated version.
// This is deliberately a closed list, separate from provenance semantics: a new implementation is
// trusted only after it is reviewed and added here, never because its version number is higher.
//   2, album-capable factory -> VoidRelease1155V4: albumCreated(), no hasStandaloneEditions()
//   2, pre-album factory     -> pre-album implementation: no album getters
//   3, album-capable factory -> VoidRelease1155V5: albumCreated() and hasStandaloneEditions()
//   4, album-capable factory -> VoidRelease1155V6Sequential: V4's getters (albumCreated(), no hasStandaloneEditions())
const LIFECYCLE_GETTERS = Object.freeze({
  V4: Object.freeze({ albumCreated: true, hasStandaloneEditions: false }),
  PRE_ALBUM: Object.freeze({ albumCreated: false, hasStandaloneEditions: false }),
  V5: Object.freeze({ albumCreated: true, hasStandaloneEditions: true }),
});
const LIFECYCLE_IMPLEMENTATIONS = Object.freeze({
  2: (deployment) => (deployment.albumCapable === true ? LIFECYCLE_GETTERS.V4 : LIFECYCLE_GETTERS.PRE_ALBUM),
  3: (deployment) => (deployment.albumCapable === true ? LIFECYCLE_GETTERS.V5 : null),
  4: (deployment) => (deployment.albumCapable === true ? LIFECYCLE_GETTERS.V4 : null),
});

/**
 * Which lifecycle getters a release clone must answer, from trusted deployment metadata, never from
 * an error: a failed or rate-limited eth_call is not evidence that a getter is missing. The factory
 * must be a recorded release deployment whose releaseVersion equals the binding's version, and that
 * version must be a known implementation in LIFECYCLE_IMPLEMENTATIONS. Returns null otherwise, so
 * callers fail closed before any chain read.
 */
export function lifecycleExpectations({ implementationVersion, factoryAddress }) {
  const version = Number(implementationVersion);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  const deployment = releaseDeploymentForFactory(factoryAddress);
  if (!deployment || Number(deployment.releaseVersion) !== version) return null;
  const implementation = Object.hasOwn(LIFECYCLE_IMPLEMENTATIONS, version) ? LIFECYCLE_IMPLEMENTATIONS[version] : null;
  return implementation ? implementation(deployment) : null;
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
  return { albumCapable: expect.albumCreated, albumCreated: albumCreated === true, standaloneFlag, existingTokenIds, hasEditions: standaloneFlag === true || existingTokenIds.length > 0 };
}

const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Fetches, now (never from a page-load snapshot), the canonical token IDs and recorded factory of one
 * bound release from the owner-only, release-scoped GET /studio/releases/:id/lifecycle-editions. That
 * response lists every token ID the server stored for the release's editions, with no row cap, so an
 * edition created, mined, renamed or republished after the page loaded is still checked by its stored
 * ID. Throws CURRENT_EDITIONS_UNAVAILABLE_MESSAGE when the fetch fails or times out, or when the
 * response is not marked complete for this release or cannot establish its single binding to this
 * contract. An empty tokenIds array in a complete response means the release has no stored editions.
 */
export async function readCurrentReleaseEditions({ fetchEditions, releaseId, releaseContractAddress, timeoutMs = CATALOG_REFRESH_TIMEOUT_MS }) {
  const unavailable = () => new Error(CURRENT_EDITIONS_UNAVAILABLE_MESSAGE);
  if (!releaseId || !ethers.isAddress(releaseContractAddress || "")) throw unavailable();
  let timer;
  let payload;
  try {
    payload = await Promise.race([
      Promise.resolve().then(fetchEditions),
      new Promise((_, reject) => { timer = setTimeout(() => reject(unavailable()), timeoutMs); }),
    ]);
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(timer);
  }
  if (!payload || payload.releaseId !== releaseId || payload.complete !== true || !Array.isArray(payload.tokenIds) || !Array.isArray(payload.releaseBindings)) throw unavailable();
  const contract = ethers.getAddress(releaseContractAddress);
  const bindings = payload.releaseBindings.filter((row) => row?.release_id === releaseId && ethers.isAddress(row?.release_contract_address || "") && ethers.getAddress(row.release_contract_address) === contract);
  const factories = new Set(bindings.map((row) => (ethers.isAddress(row?.factory_address || "") ? ethers.getAddress(row.factory_address) : "")));
  if (bindings.length === 0 || factories.size !== 1 || factories.has("")) throw unavailable();
  const tokenIds = new Set();
  for (const value of payload.tokenIds) {
    if (typeof value !== "string" || !/^[0-9]{1,78}$/.test(value)) throw unavailable();
    const tokenId = BigInt(value);
    if (tokenId === 0n || tokenId > MAX_UINT256) throw unavailable();
    tokenIds.add(tokenId);
  }
  return { tokenIds: [...tokenIds], factoryAddress: [...factories][0] };
}

/** The D3 rule for a release-type change. Returns null when allowed. */
export function releaseTypeChangeBlocker({ toType, lifecycle }) {
  if (lifecycle.albumCreated && toType !== "ALBUM") return { code: "ALBUM_TYPE_LOCKED", message: ALBUM_TYPE_LOCKED_MESSAGE };
  // A clone without album functions can never become an album, whatever its editions.
  if (toType === "ALBUM" && lifecycle.albumCapable === false) return { code: "ALBUM_NOT_SUPPORTED", message: ALBUM_NOT_SUPPORTED_MESSAGE };
  if (toType === "ALBUM" && !lifecycle.albumCreated && lifecycle.hasEditions) return { code: "STANDALONE_EDITIONS_EXIST", message: STANDALONE_EDITIONS_EXIST_MESSAGE };
  return null;
}
