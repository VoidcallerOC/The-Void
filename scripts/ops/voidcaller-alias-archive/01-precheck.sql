-- PRE-CHECK (read only). Run immediately before 02-archive.sql and keep the output.
-- One row per target or protected artist. Save dependency_fingerprint values: 03-postcheck.sql must match them.
BEGIN TRANSACTION READ ONLY;

WITH subjects(role, id, slug, expected_after) AS (VALUES
  ('TARGET',    'artist-bd29734b-a262-4922-93e1-b390a0c7a142', 'voidcaller-2', 'ARCHIVED'),
  ('TARGET',    'artist-78155b6c-f6b4-4bff-adb5-2d6d123d6d36', 'voidcaller-3', 'ARCHIVED'),
  ('TARGET',    'artist-f67c333a-05ab-4d27-8eb4-98c713a6d6fb', 'voidcaller-4', 'ARCHIVED'),
  ('TARGET',    'artist-7fa23525-21a5-4b68-ae56-b2ed4acc2495', 'voidcaller-5', 'ARCHIVED'),
  ('TARGET',    'artist-f6be711f-c5f1-43de-bba3-a085950ae1d1', 'voidcaller-6', 'ARCHIVED'),
  ('TARGET',    'artist-bdd37451-a70a-42a2-9fc6-0a8eb770c0e3', 'voidcaller-8', 'ARCHIVED'),
  ('PROTECTED', 'voidcaller',                                  'voidcaller',   'ACTIVE'),
  ('PROTECTED', 'artist-cf2c2990-b0b0-4933-bcac-556cf55c0724', 'voidcaller-7', 'ACTIVE')
),
rel AS (SELECT r.* FROM releases r WHERE r.artist_id IN (SELECT id FROM subjects)),
ed  AS (SELECT e.* FROM editions e WHERE e.release_id IN (SELECT id FROM rel)),
tok AS (
  SELECT r.artist_id, t.edition_id, t.token_id, t.metadata_uri, c.chain_id, lower(c.address) AS contract
  FROM tokens t JOIN contracts c ON c.id = t.contract_id
  JOIN editions e ON e.id = t.edition_id JOIN rel r ON r.id = e.release_id
),
-- Stable columns only: indexer bookkeeping (updated_at, watermarks) is excluded on purpose.
parts AS (
  SELECT artist_id AS id, 'owner|' || lower(owner_wallet) || '|' || role AS item FROM artist_owners WHERE artist_id IN (SELECT id FROM subjects)
  UNION ALL SELECT artist_id, 'profile|' || md5(coalesce(bio, '') || coalesce(website_url, '') || coalesce(social_links::text, '') || coalesce(profile_metadata::text, '')) FROM artist_profiles WHERE artist_id IN (SELECT id FROM subjects)
  UNION ALL SELECT artist_id, 'verification|' || id || '|' || status FROM artist_verification_applications WHERE artist_id IN (SELECT id FROM subjects)
  UNION ALL SELECT artist_id, 'release|' || id || '|' || slug || '|' || status || '|' || md5(coalesce(release_metadata::text, '')) FROM rel
  UNION ALL SELECT r.artist_id, 'edition|' || e.id || '|' || e.status || '|' || coalesce(e.supply::text, '') || '|' || coalesce(e.contract_id::text, '') FROM ed e JOIN rel r ON r.id = e.release_id
  UNION ALL SELECT artist_id, 'token|' || edition_id || '|' || chain_id || '|' || contract || '|' || token_id::text || '|' || coalesce(metadata_uri, '') FROM tok
  UNION ALL SELECT s.id, 'provenance|' || p.id || '|' || p.release_id || '|' || p.edition_id || '|' || p.creator_artist_id || '|' || p.creator_wallet || '|' || p.manifest_sha256 || '|' || p.metadata_sha256 || '|' || p.anchor_status || '|' || p.verification_status || '|' || coalesce(p.transaction_hash, '')
    FROM provenance_proofs p JOIN subjects s ON s.id = p.creator_artist_id OR p.release_id IN (SELECT id FROM rel WHERE artist_id = s.id)
  UNION ALL SELECT s.id, 'experience|' || x.id || '|' || x.status || '|' || coalesce(x.release_id, '') || '|' || coalesce(x.edition_id, '') || '|' || md5(coalesce(x.requirements::text, '') || coalesce(x.media_config::text, ''))
    FROM experiences x JOIN subjects s ON s.id = x.artist_id OR x.release_id IN (SELECT id FROM rel WHERE artist_id = s.id)
  UNION ALL SELECT artist_id, 'media|' || id || '|' || storage_key || '|' || media_type FROM media_assets WHERE artist_id IN (SELECT id FROM subjects)
  UNION ALL SELECT k.artist_id, 'transfer|' || tr.transaction_hash || '|' || tr.log_index || '|' || tr.from_wallet || '|' || tr.to_wallet || '|' || tr.amount::text || '|' || tr.is_canonical::text
    FROM transfers tr JOIN tok k ON tr.chain_id = k.chain_id AND lower(tr.contract_address) = k.contract AND tr.token_id = k.token_id
  UNION ALL SELECT k.artist_id, 'holder|' || o.wallet_address || '|' || o.amount::text
    FROM ownership_snapshots o JOIN tok k ON o.chain_id = k.chain_id AND lower(o.contract_address) = k.contract AND o.token_id = k.token_id WHERE o.amount > 0
  UNION ALL SELECT k.artist_id, 'listing|' || l.listing_id::text || '|' || l.status || '|' || l.seller_wallet || '|' || l.amount::text || '|' || l.remaining_amount::text || '|' || l.price_wei::text
    FROM listings l JOIN contracts tc ON tc.id = l.token_contract_id JOIN tok k ON l.chain_id = k.chain_id AND lower(tc.address) = k.contract AND l.token_id = k.token_id
  UNION ALL SELECT k.artist_id, 'purchase|' || p.transaction_hash || '|' || p.settlement_log_index || '|' || p.buyer_wallet || '|' || p.seller_wallet || '|' || p.quantity::text || '|' || p.sale_price_wei::text || '|' || p.status
    FROM purchases p JOIN tok k ON p.chain_id = k.chain_id AND lower(p.token_contract_address) = k.contract AND p.token_id = k.token_id
  UNION ALL SELECT k.artist_id, 'primary|' || pp.transaction_hash || '|' || pp.log_index || '|' || pp.buyer_wallet || '|' || pp.quantity::text || '|' || pp.paid_wei::text || '|' || pp.status
    FROM primary_purchases pp JOIN tok k ON pp.chain_id = k.chain_id AND lower(pp.token_contract_address) = k.contract AND pp.token_id = k.token_id
  UNION ALL SELECT s.id, 'audit|' || ae.id::text
    FROM audit_events ae JOIN subjects s ON ae.subject_id = s.id OR ae.subject_id IN (SELECT id FROM rel WHERE artist_id = s.id) OR ae.subject_id IN (SELECT e.id FROM ed e JOIN rel r ON r.id = e.release_id WHERE r.artist_id = s.id)
),
fingerprints AS (
  SELECT s.id, count(p.item) AS dependency_rows, md5(coalesce(string_agg(p.item, E'\n' ORDER BY p.item), '')) AS dependency_fingerprint
  FROM subjects s LEFT JOIN parts p ON p.id = s.id GROUP BY s.id
),
summary AS (
  SELECT s.role, s.id, s.slug, s.expected_after, a.id IS NOT NULL AS exact_id_slug_match, a.status,
    (SELECT count(*) FROM rel WHERE artist_id = s.id) AS releases_total,
    (SELECT count(*) FROM rel WHERE artist_id = s.id AND status = 'PUBLISHED') AS releases_published,
    (SELECT count(*) FROM rel WHERE artist_id = s.id AND status IN ('DRAFT', 'REVIEW')) AS releases_draft,
    (SELECT count(*) FROM rel WHERE artist_id = s.id AND status = 'ARCHIVED') AS releases_archived,
    (SELECT count(*) FROM experiences x WHERE x.artist_id = s.id AND x.status = 'PUBLISHED') AS published_experiences,
    f.dependency_rows, f.dependency_fingerprint
  FROM subjects s
  LEFT JOIN artists a ON a.id = s.id AND a.slug = s.slug
  JOIN fingerprints f ON f.id = s.id
),
certified AS (
  SELECT
    EXISTS (SELECT 1 FROM releases WHERE id = 'release-8f6d5a9f-585d-4948-b05b-7098125d16cf' AND artist_id = 'artist-cf2c2990-b0b0-4933-bcac-556cf55c0724' AND slug = 'voidcaller' AND status = 'PUBLISHED') AS certified_release_ok,
    EXISTS (SELECT 1 FROM editions WHERE id = 'edition-ecf27444-94b7-40d5-bace-5f061792f55e' AND release_id = 'release-8f6d5a9f-585d-4948-b05b-7098125d16cf' AND status = 'PUBLISHED') AS certified_edition_ok,
    EXISTS (SELECT 1 FROM tokens t JOIN contracts c ON c.id = t.contract_id
            WHERE t.edition_id = 'edition-ecf27444-94b7-40d5-bace-5f061792f55e' AND c.chain_id = 43113
              AND lower(c.address) = '0x82b26da27136935454bdf1e40801190b521b82e5'
              AND t.token_id = 33778802922810732976408591241428358474475553907731009337085064305512658576739) AS certified_token_ok,
    (SELECT string_agg(l.listing_id::text || ':' || l.status || ':' || l.seller_wallet || ':' || l.remaining_amount::text, ', ')
       FROM listings l JOIN contracts tc ON tc.id = l.token_contract_id
      WHERE l.chain_id = 43113 AND l.listing_id = 1 AND lower(tc.address) = '0x82b26da27136935454bdf1e40801190b521b82e5'
        AND l.token_id = 33778802922810732976408591241428358474475553907731009337085064305512658576739) AS listing_1
)
SELECT su.role, su.id AS artist_id, su.slug, su.exact_id_slug_match, su.status AS current_status, su.expected_after,
  su.releases_total, su.releases_published, su.releases_draft, su.releases_archived, su.published_experiences,
  (su.role = 'TARGET' AND su.releases_published > 0) AS target_has_published_release,
  su.dependency_rows, su.dependency_fingerprint,
  c.certified_release_ok, c.certified_edition_ok, c.certified_token_ok, c.listing_1,
  bool_and(su.exact_id_slug_match AND su.status = 'ACTIVE'
           AND NOT (su.role = 'TARGET' AND (su.releases_published > 0 OR su.published_experiences > 0))) OVER ()
    AND c.certified_release_ok AND c.certified_edition_ok AND c.certified_token_ok AS ready_to_archive
FROM summary su CROSS JOIN certified c
ORDER BY su.role DESC, su.slug;

ROLLBACK;
