-- ONE-TIME PRODUCTION OPERATION. Not part of server/migrations; never runs on deploy.
-- REVERSAL: returns exactly the same six alias artist rows ARCHIVED -> ACTIVE.
-- Changes artists.status and artists.updated_at for those six rows only. Every dependent
-- table (owners, profiles, releases, editions, tokens, provenance, experiences, media,
-- transfers, ownership, listings, purchases, audit) is untouched.
-- Canonical `voidcaller` and the certified Fuji artist `voidcaller-7` are protected.
-- Idempotent: all six ARCHIVED -> changes 6; all six ACTIVE -> changes 0; anything else aborts.
BEGIN;

DO $$
DECLARE
  target_ids   CONSTANT text[] := ARRAY[
    'artist-bd29734b-a262-4922-93e1-b390a0c7a142',
    'artist-78155b6c-f6b4-4bff-adb5-2d6d123d6d36',
    'artist-f67c333a-05ab-4d27-8eb4-98c713a6d6fb',
    'artist-7fa23525-21a5-4b68-ae56-b2ed4acc2495',
    'artist-f6be711f-c5f1-43de-bba3-a085950ae1d1',
    'artist-bdd37451-a70a-42a2-9fc6-0a8eb770c0e3'];
  target_slugs CONSTANT text[] := ARRAY[
    'voidcaller-2', 'voidcaller-3', 'voidcaller-4', 'voidcaller-5', 'voidcaller-6', 'voidcaller-8'];
  expected     CONSTANT int := 6;
  matched int;
  active_count int;
  archived_count int;
  changed int;
BEGIN
  IF cardinality(target_ids) <> expected OR cardinality(target_slugs) <> expected THEN
    RAISE EXCEPTION 'target list must contain exactly % (id, slug) pairs', expected;
  END IF;
  IF 'voidcaller' = ANY (target_ids) OR 'voidcaller' = ANY (target_slugs) THEN
    RAISE EXCEPTION 'canonical artist voidcaller must not be a target';
  END IF;
  IF 'artist-cf2c2990-b0b0-4933-bcac-556cf55c0724' = ANY (target_ids) OR 'voidcaller-7' = ANY (target_slugs) THEN
    RAISE EXCEPTION 'certified Fuji artist voidcaller-7 must not be a target';
  END IF;

  -- Protected rows must be in their expected state before anything changes.
  PERFORM 1 FROM artists WHERE id = 'voidcaller' AND slug = 'voidcaller' AND status = 'ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'canonical voidcaller is not ACTIVE'; END IF;
  PERFORM 1 FROM artists WHERE id = 'artist-cf2c2990-b0b0-4933-bcac-556cf55c0724' AND slug = 'voidcaller-7' AND status = 'ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'voidcaller-7 is not ACTIVE'; END IF;
  PERFORM 1 FROM releases WHERE id = 'release-8f6d5a9f-585d-4948-b05b-7098125d16cf'
    AND artist_id = 'artist-cf2c2990-b0b0-4933-bcac-556cf55c0724' AND status = 'PUBLISHED';
  IF NOT FOUND THEN RAISE EXCEPTION 'certified release is not PUBLISHED under voidcaller-7'; END IF;

  -- Every target must exist with this exact id AND slug.
  SELECT count(*) INTO matched
  FROM artists a JOIN unnest(target_ids, target_slugs) AS t(id, slug) ON a.id = t.id AND a.slug = t.slug;
  IF matched <> expected THEN
    RAISE EXCEPTION 'expected % exact (id, slug) matches, found %', expected, matched;
  END IF;

  -- No target may own live published content.
  IF EXISTS (SELECT 1 FROM releases WHERE artist_id = ANY (target_ids) AND status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'a target artist owns a PUBLISHED release';
  END IF;
  IF EXISTS (SELECT 1 FROM experiences WHERE artist_id = ANY (target_ids) AND status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'a target artist owns a PUBLISHED experience';
  END IF;

  -- Only all-ACTIVE (first run) or all-ARCHIVED (re-run) is acceptable.
  SELECT count(*) FILTER (WHERE a.status = 'ACTIVE'), count(*) FILTER (WHERE a.status = 'ARCHIVED')
    INTO active_count, archived_count
  FROM artists a JOIN unnest(target_ids, target_slugs) AS t(id, slug) ON a.id = t.id AND a.slug = t.slug;
  IF NOT (active_count = expected OR archived_count = expected) THEN
    RAISE EXCEPTION 'targets are in a mixed state (ACTIVE=%, ARCHIVED=%); refusing to continue', active_count, archived_count;
  END IF;

  UPDATE artists AS a
  SET status = 'ACTIVE', updated_at = now()
  FROM unnest(target_ids, target_slugs) AS t(id, slug)
  WHERE a.id = t.id
    AND a.slug = t.slug
    AND a.status = 'ARCHIVED'
    AND a.id NOT IN ('voidcaller', 'artist-cf2c2990-b0b0-4933-bcac-556cf55c0724');
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> archived_count THEN
    RAISE EXCEPTION 'expected to restore % rows, restored %', archived_count, changed;
  END IF;

  -- Post-conditions.
  SELECT count(*) INTO active_count
  FROM artists a JOIN unnest(target_ids, target_slugs) AS t(id, slug) ON a.id = t.id AND a.slug = t.slug
  WHERE a.status = 'ACTIVE';
  IF active_count <> expected THEN RAISE EXCEPTION 'expected % ACTIVE targets, found %', expected, active_count; END IF;
  PERFORM 1 FROM artists WHERE id = 'voidcaller' AND status = 'ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'canonical voidcaller changed'; END IF;
  PERFORM 1 FROM artists WHERE id = 'artist-cf2c2990-b0b0-4933-bcac-556cf55c0724' AND status = 'ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'voidcaller-7 changed'; END IF;

  RAISE NOTICE 'voidcaller alias reversal: % row(s) restored (6 on first run, 0 on re-run)', changed;
END
$$;

COMMIT;
