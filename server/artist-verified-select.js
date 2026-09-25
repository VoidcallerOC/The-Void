import { LEGACY_CHAIN_ID, LEGACY_CONTRACT } from "../src/lib/legacy-genesis.js";

// Public artist rows are verified only when a studio application is VERIFIED
// or a persisted contract-owner claim exists for this exact slug + legacy
// mainnet collection. Catalog fixtures do not grant the badge.
export const ARTIST_SELECT = `SELECT a.*, p.bio, p.website_url, p.social_links, p.profile_metadata,
      (
        EXISTS (
          SELECT 1 FROM artist_verification_applications v
          WHERE v.status='VERIFIED' AND (v.artist_id=a.id OR lower(v.slug)=lower(a.slug))
        )
        OR EXISTS (
          SELECT 1 FROM artist_contract_verifications c
          WHERE lower(c.artist_slug)=lower(a.slug)
            AND lower(c.contract_address)=lower('${LEGACY_CONTRACT}')
            AND c.chain_id=${LEGACY_CHAIN_ID}
        )
      ) AS verified
    FROM artists a LEFT JOIN artist_profiles p ON p.artist_id=a.id`;
