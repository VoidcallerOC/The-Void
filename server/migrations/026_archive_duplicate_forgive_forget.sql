BEGIN;

-- Three "Forgive & Forget" releases were published on Fuji on 2026-10-03.
-- forgive-forget-18 (release-b96d6a64…) is canonical: it carries the public
-- preview, the gated demo experience, the configured primary sale and the
-- only indexed purchase. Retire the two earlier duplicates from discovery:
--   forgive-forget-13  release-7ea0a0a6…  token 3505407066…4595 (no preview, no experience)
--   forgive-forget-17  release-c0e0e419…  token 9680465111…7275 (unlocked the wrong audio)
-- Only lifecycle status changes. Tokens, sales, ownership, transfers and
-- purchases are untouched, and a release is skipped if any purchase was ever
-- indexed for its tokens. IDs read from the production public API.

CREATE TEMP TABLE retired_forgive_forget ON COMMIT DROP AS
SELECT r.id AS release_id
FROM releases AS r
WHERE r.id IN (
    'release-7ea0a0a6-495f-400f-9b90-c06621e8b062',
    'release-c0e0e419-d754-4a52-80e9-81f5b04a9395'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM editions AS e
    JOIN tokens AS t ON t.edition_id = e.id
    JOIN contracts AS c ON c.id = t.contract_id
    WHERE e.release_id = r.id
      AND (
        EXISTS (SELECT 1 FROM primary_purchases AS pp WHERE pp.chain_id = c.chain_id AND LOWER(pp.token_contract_address) = LOWER(c.address) AND pp.token_id = t.token_id)
        OR EXISTS (SELECT 1 FROM purchases AS p WHERE p.chain_id = c.chain_id AND LOWER(p.token_contract_address) = LOWER(c.address) AND p.token_id = t.token_id)
      )
  );

UPDATE experiences AS x
SET status = 'ARCHIVED', updated_at = now()
WHERE x.status = 'PUBLISHED'
  AND (
    x.release_id IN (SELECT release_id FROM retired_forgive_forget)
    OR x.edition_id IN (SELECT e.id FROM editions AS e WHERE e.release_id IN (SELECT release_id FROM retired_forgive_forget))
  );

UPDATE editions AS e
SET status = 'ARCHIVED', updated_at = now()
WHERE e.status = 'PUBLISHED'
  AND e.release_id IN (SELECT release_id FROM retired_forgive_forget);

UPDATE releases AS r
SET status = 'ARCHIVED', updated_at = now()
WHERE r.status = 'PUBLISHED'
  AND r.id IN (SELECT release_id FROM retired_forgive_forget);

COMMIT;
