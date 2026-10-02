import { ethers } from "ethers";
import { ApiError } from "./api-errors.js";
import { requiredText } from "./validation.js";

/** Artist-bound publication authority.
 *
 * VERIFIED ARTIST → AUTHORIZED WALLET → ARTIST-OWNED RELEASE → ARTIST-OWNED EDITION → TOKEN.
 *
 * Database UUIDs stay the source of identity. The on-chain artist key is derived
 * from the database artist id; release/edition ids and the token id keep the
 * existing "the-void:edition:v1" derivation. VoidRelease1155V3 enforces the same
 * chain on-chain (registerArtist / setArtistWallet / bindRelease). */

const ARTIST_KEY_DOMAIN = "the-void:artist:v1:";

export function artistKeyFor(artistId) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${ARTIST_KEY_DOMAIN}${requiredText(artistId, "artistId", { max: 128 })}`));
}

export function onChainEditionIdentity(releaseSlug, editionSlug) {
  const releaseId = ethers.encodeBytes32String(requiredText(releaseSlug, "release.slug", { max: 31 }));
  const editionId = ethers.encodeBytes32String(requiredText(editionSlug, "edition.slug", { max: 31 }));
  const digest = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32", "bytes32"], ["the-void:edition:v1", releaseId, editionId]));
  const tokenId = BigInt(digest);
  return { releaseId, editionId, tokenId: tokenId === 0n ? 1n : tokenId };
}

const PUBLISH_AUTHORITY_SQL = `SELECT a.id, a.status,
    EXISTS (SELECT 1 FROM artist_owners ao WHERE ao.artist_id=a.id AND lower(ao.owner_wallet)=$2) AS wallet_authorized,
    (SELECT v.status FROM artist_verification_applications v
      WHERE v.artist_id=a.id AND v.status IN ('VERIFIED','REVOKED')
      ORDER BY COALESCE(v.reviewed_at, v.updated_at) DESC, v.updated_at DESC LIMIT 1) AS verification_decision,
    EXISTS (SELECT 1 FROM artist_verification_applications v
      JOIN artist_owners vo ON vo.artist_id=a.id AND lower(vo.owner_wallet)=lower(v.wallet_address)
      WHERE v.artist_id=a.id AND v.status='VERIFIED') AS application_verified,
    EXISTS (SELECT 1 FROM artist_contract_verifications c
      JOIN artist_owners co ON co.artist_id=a.id AND lower(co.owner_wallet)=lower(c.wallet_address)
      WHERE lower(c.artist_slug)=lower(a.slug)) AS contract_verified
  FROM artists a WHERE a.id=$1 LIMIT 1`;

/** Fails closed unless `wallet` is an owner wallet of a verified, active,
 * non-revoked artist. Verification counts only when it was granted to this
 * artist id (or this artist's slug via contract-owner proof) for one of this
 * artist's own wallets, so a slug collision never lends one artist's
 * verification to another. */
export async function assertArtistMayPublish(db, { artistId, wallet }) {
  const normalizedWallet = String(wallet || "").toLowerCase();
  const { rows } = await db.query(PUBLISH_AUTHORITY_SQL, [requiredText(artistId, "artistId"), normalizedWallet]);
  const row = rows[0];
  if (!row) throw new ApiError(404, "ARTIST_NOT_FOUND", "Artist was not found.");
  if (!row.wallet_authorized) throw new ApiError(403, "ARTIST_WALLET_NOT_AUTHORIZED", "The authenticated wallet is not authorized for this artist.");
  if (row.status !== "ACTIVE") throw new ApiError(403, "ARTIST_INACTIVE", "This artist is not active and cannot publish.");
  if (row.verification_decision === "REVOKED") throw new ApiError(403, "ARTIST_VERIFICATION_REVOKED", "This artist's verification was revoked. Publishing is disabled.");
  if (!row.application_verified && !row.contract_verified) throw new ApiError(403, "ARTIST_NOT_VERIFIED", "Only verified artists can publish releases.");
  return { artistId: row.id, wallet: normalizedWallet };
}

/** Rejects a token ID already recorded for another artist's edition on the same
 * contract, so a colliding release/edition slug can never re-point an existing
 * token row (tokens upsert on contract_id + token_id). */
export async function assertTokenNotOwnedByAnotherArtist(db, { artistId, contractAddress, chainId, tokenId }) {
  const { rows } = await db.query(
    `SELECT r.artist_id FROM tokens t JOIN contracts c ON c.id=t.contract_id JOIN editions e ON e.id=t.edition_id JOIN releases r ON r.id=e.release_id
      WHERE lower(c.address)=lower($1) AND c.chain_id=$2 AND t.token_id=$3 AND r.artist_id<>$4 LIMIT 1`,
    [contractAddress, chainId, String(tokenId), artistId],
  );
  if (rows[0]) throw new ApiError(409, "TOKEN_OWNED_BY_ANOTHER_ARTIST", "This release and edition would reuse a token that belongs to another artist. Rename the release or edition.");
}

/** The registrar payload that mirrors a verified database artist onto
 * VoidRelease1155V3: registerArtist(artistKey), setArtistWallet(artistKey, wallet, true),
 * bindRelease(releaseId, artistKey). The artist wallet then calls createEdition. */
export async function releaseAuthorizationFor(db, { artistId, wallet, releaseSlug, editionSlug }) {
  const authority = await assertArtistMayPublish(db, { artistId, wallet });
  const ids = onChainEditionIdentity(releaseSlug, editionSlug);
  return { artistId: authority.artistId, artistKey: artistKeyFor(authority.artistId), wallet: ethers.getAddress(authority.wallet), ...ids };
}
