// Test-only: answers the artist-authorization queries as a verified, active
// artist owned by the requesting wallet, and forwards everything else to the
// test's own `db.query` mock (so its mockResolvedValueOnce order is unchanged).
export function verifiedArtistDb(db, { verified = true, revoked = false, walletAuthorized = true, status = "ACTIVE", foreignTokenArtist = null, creatorOwns = true } = {}) {
  return {
    query: async (sql, params = []) => {
      if (sql.includes("AS wallet_authorized")) {
        return { rows: [{ id: params[0], status, wallet_authorized: walletAuthorized, verification_decision: revoked ? "REVOKED" : verified ? "VERIFIED" : null, application_verified: verified, contract_verified: false }] };
      }
      if (sql.includes("r.artist_id<>$4")) return { rows: foreignTokenArtist ? [{ artist_id: foreignTokenArtist }] : [] };
      if (sql.startsWith("SELECT 1 FROM artist_owners")) return { rows: creatorOwns ? [{ "?column?": 1 }] : [] };
      return db.query(sql, params);
    },
  };
}
