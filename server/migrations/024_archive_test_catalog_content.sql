BEGIN;

-- Remove only the confirmed Fuji E2E and Pinata certification catalog records
-- from public discovery. Preserve accounts, artist ownership/profile rows,
-- tokens, listings, transactions, and purchases; only lifecycle status changes.
-- These IDs were read from the production public API on 2026-09-29.
UPDATE experiences AS x
SET status = 'ARCHIVED', updated_at = now()
WHERE x.status = 'PUBLISHED'
  AND (
    x.release_id IN (
      'release-b4bb9c4f-b683-4145-9a9c-9fe32ad609f7',
      'release-7f12ecfb-99eb-4b05-9b07-f862480829c5',
      'release-f049bc8c-2ff1-4ebf-8830-ebd92784864a',
      'release-f2ce5be7-969a-4e9f-87fb-be839b9df380',
      'release-cf0bcf5f-3f6a-466f-9661-0c56f58fe3e3',
      'release-176a05cf-fe88-4c33-a7db-c9ef4b1e90de'
    )
    OR x.edition_id IN (
      SELECT e.id
      FROM editions AS e
      WHERE e.release_id IN (
        'release-b4bb9c4f-b683-4145-9a9c-9fe32ad609f7',
        'release-7f12ecfb-99eb-4b05-9b07-f862480829c5',
        'release-f049bc8c-2ff1-4ebf-8830-ebd92784864a',
        'release-f2ce5be7-969a-4e9f-87fb-be839b9df380',
        'release-cf0bcf5f-3f6a-466f-9661-0c56f58fe3e3',
        'release-176a05cf-fe88-4c33-a7db-c9ef4b1e90de'
      )
    )
  );

UPDATE editions AS e
SET status = 'ARCHIVED', updated_at = now()
WHERE e.status = 'PUBLISHED'
  AND e.release_id IN (
    'release-b4bb9c4f-b683-4145-9a9c-9fe32ad609f7',
    'release-7f12ecfb-99eb-4b05-9b07-f862480829c5',
    'release-f049bc8c-2ff1-4ebf-8830-ebd92784864a',
    'release-f2ce5be7-969a-4e9f-87fb-be839b9df380',
    'release-cf0bcf5f-3f6a-466f-9661-0c56f58fe3e3',
    'release-176a05cf-fe88-4c33-a7db-c9ef4b1e90de'
  );

UPDATE releases AS r
SET status = 'ARCHIVED', updated_at = now()
WHERE r.status = 'PUBLISHED'
  AND r.id IN (
    'release-b4bb9c4f-b683-4145-9a9c-9fe32ad609f7',
    'release-7f12ecfb-99eb-4b05-9b07-f862480829c5',
    'release-f049bc8c-2ff1-4ebf-8830-ebd92784864a',
    'release-f2ce5be7-969a-4e9f-87fb-be839b9df380',
    'release-cf0bcf5f-3f6a-466f-9661-0c56f58fe3e3',
    'release-176a05cf-fe88-4c33-a7db-c9ef4b1e90de'
  );

-- These four ACTIVE public profiles are the named test accounts WER/SDFG/QWE/ASDF.
-- Archive only their artist catalog profiles; do not delete or modify account,
-- authentication, ownership, or artist_profiles rows.
UPDATE artists AS a
SET status = 'ARCHIVED', updated_at = now()
WHERE a.status = 'ACTIVE'
  AND a.id IN (
    'artist-845101ad-8dbd-40ad-9c64-b60cbcfe183e',
    'artist-fa19e2f0-bc20-4b7c-8698-c5f1db59fd6a',
    'artist-da7b5bfb-7cc3-4c35-be3a-7543e4e54138',
    'artist-454ea216-9ce5-4c9d-b904-08eb7bb18bf3'
  );

COMMIT;
