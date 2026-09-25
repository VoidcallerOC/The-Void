BEGIN;

-- Seed the original Voidcaller collection (Avalanche C-Chain mainnet, chain
-- 43114) into the public catalog. PR #27 planned these rows but only shipped
-- constants in src/lib/legacy-genesis.js. The Studio cannot create them
-- because createEdition always binds the certified Fuji contract.
--
-- Data only: no new tables, so the RLS lockdown from 017 is unchanged.
-- Every insert uses ON CONFLICT DO NOTHING. Re-running this body leaves the
-- same rows and never overwrites later edits.
--
-- The mainnet contract row is catalog metadata. It is not an indexer
-- registration. The indexer and marketplace stay Fuji-only, and ownership for
-- these experiences is read live via balanceOf (server/legacy-ownership.js).
--
-- Full-length tracks stay gated. No master audio path or storage key is
-- written here. protectedMedia stays empty until the owner attaches Pinata
-- assets in the Studio, and until then the media gateway fails closed with
-- PROTECTED_MEDIA_NOT_CONFIGURED.

-- A Studio-created artist can hold the slug 'voidcaller' under a random id.
-- The public API and frontend already hide that row as a Voidcaller alias
-- (src/lib/summit-demo.js). Move its slug to the next free 'voidcaller-N'
-- (still hidden as an alias) so the canonical id 'voidcaller' can take the
-- slug. Only the slug changes; ids, owners and releases are untouched.
WITH aliases AS (
  SELECT id, row_number() OVER (ORDER BY id) AS ordinal
  FROM artists
  WHERE slug = 'voidcaller' AND id <> 'voidcaller'
), available AS (
  SELECT 'voidcaller-' || n AS slug, row_number() OVER (ORDER BY n) AS ordinal
  FROM generate_series(2, 10000) AS n
  WHERE NOT EXISTS (SELECT 1 FROM artists taken WHERE taken.slug = 'voidcaller-' || n)
), assignments AS (
  SELECT aliases.id, available.slug
  FROM aliases
  JOIN available USING (ordinal)
)
UPDATE artists
SET slug = assignments.slug,
    updated_at = now()
FROM assignments
WHERE artists.id = assignments.id;

INSERT INTO artists (id, slug, display_name, status, application_metadata)
VALUES (
  'voidcaller',
  'voidcaller',
  'Voidcaller',
  'ACTIVE',
  '{"handle": "VoidcallerOC", "profileArtwork": "/assets/voidcaller_art_4.png", "artwork": "/assets/voidcaller_art_4.png", "banner": "/assets/voidcaller_art_6.png", "seed": "019_seed_voidcaller_legacy"}'::jsonb
)
ON CONFLICT DO NOTHING;

INSERT INTO artist_profiles (artist_id, bio, website_url, social_links, profile_metadata)
VALUES (
  'voidcaller',
  'A music-native project where records become relics and ownership unlocks the full experience.',
  NULL,
  '{"discord": "https://discord.gg/9htWQv8v6t", "x": "https://x.com/VoidcallerOC"}'::jsonb,
  '{"profileArtwork": "/assets/voidcaller_art_4.png", "banner": "/assets/voidcaller_art_6.png"}'::jsonb
)
ON CONFLICT DO NOTHING;

-- Verified on-chain owner() of the legacy contract. The same wallet holds the
-- persisted contract-owner verification for slug 'voidcaller' (migration 018).
INSERT INTO artist_owners (artist_id, owner_wallet, role)
VALUES ('voidcaller', '0x284c09a7cc187e096cbbdc88d99defe6df32180a', 'OWNER')
ON CONFLICT DO NOTHING;

INSERT INTO contracts (chain_id, chain_key, address, contract_type, name, verified_source_url, metadata)
VALUES (
  43114,
  'cchain',
  '0xd1b4367dd9f235f9ee61878019d66e31511e98ee',
  'ERC1155',
  'Voidcaller',
  'https://snowtrace.io/address/0xd1b4367dd9f235f9ee61878019d66e31511e98ee',
  '{"symbol": "VOIDCALLER", "legacy": true, "indexed": false, "primarySale": false, "implementation": "0x2e61967a569bc18affc5e1b9f71e00af93a268c7", "ownershipSource": "mainnet-balanceOf"}'::jsonb
)
ON CONFLICT (chain_id, address) DO NOTHING;

INSERT INTO releases (id, artist_id, slug, title, description, status, release_metadata, published_at)
VALUES (
  'voidcaller-legacy-genesis',
  'voidcaller',
  'voidcaller-legacy-genesis',
  'VOIDCALLER',
  'The first call. The first relic. The original self-titled Voidcaller EP, minted on Avalanche C-Chain.',
  'PUBLISHED',
  '{
    "subtitle": "Self-titled EP",
    "story": "The first call. The first relic. One relic unlocks the full EP. Trading on OpenSea and Joepegs. The chain remembers.",
    "artwork": "/assets/voidcaller_art_4.png",
    "legacy": true,
    "chain": "AVALANCHE",
    "chainId": 43114,
    "primarySale": false,
    "marketplaces": [
      {"name": "SNOWTRACE", "href": "https://snowtrace.io/address/0xd1b4367dd9f235f9ee61878019d66e31511e98ee"},
      {"name": "OPENSEA", "href": "https://opensea.io/collection/voidcaller-avalanche"},
      {"name": "JOEPEGS", "href": "https://joepegs.com/collections/avalanche/voidcaller"}
    ],
    "experiences": ["voidcaller-legacy-track-1", "voidcaller-legacy-track-2", "voidcaller-legacy-track-3", "voidcaller-legacy-track-0"],
    "tracks": [
      {"n": "01", "title": "The Hollow", "time": "3:57", "tokenId": 1, "previewSrc": "/assets/audio-preview/ep1-01-the-hollow-preview.mp3", "art": "/assets/track-art/ep1-the-hollow.png", "experienceId": "voidcaller-legacy-track-1"},
      {"n": "02", "title": "Don’t Look Down", "time": "4:20", "tokenId": 2, "previewSrc": "/assets/audio-preview/ep1-02-dont-look-down-preview.mp3", "art": "/assets/track-art/ep1-dont-look-down.png", "experienceId": "voidcaller-legacy-track-2"},
      {"n": "03", "title": "Complex", "time": "5:08", "tokenId": 3, "previewSrc": "/assets/audio-preview/ep1-03-complex-preview.mp3", "art": "/assets/track-art/ep1-complex.png", "experienceId": "voidcaller-legacy-track-3"},
      {"n": "04", "title": "Enough", "time": "4:46", "tokenId": 0, "previewSrc": "/assets/audio-preview/ep1-04-enough-preview.mp3", "art": "/assets/track-art/ep1-enough.png", "experienceId": "voidcaller-legacy-track-0"}
    ]
  }'::jsonb,
  now()
)
ON CONFLICT DO NOTHING;

-- Not sold through the Fuji primary sale. The frontend renders it as minted
-- and links out to OpenSea and Joepegs instead of a Collect button.
INSERT INTO editions (id, release_id, contract_id, title, tier, description, supply, status, application_metadata)
SELECT
  'voidcaller-legacy-edition',
  'voidcaller-legacy-genesis',
  c.id,
  'Chapter I · The Relic',
  'legacy',
  'The original ERC-1155 edition for the self-titled EP on Avalanche C-Chain. Collect on OpenSea or Joepegs.',
  1620,
  'PUBLISHED',
  '{
    "legacy": true,
    "primarySale": false,
    "collectable": false,
    "saleStatus": "minted",
    "chain": "AVALANCHE",
    "chainId": 43114,
    "contractAddress": "0xd1b4367dd9f235f9ee61878019d66e31511e98ee",
    "tokenIds": ["0", "1", "2", "3"],
    "artwork": "/assets/voidcaller_art_4.png",
    "includes": ["Full self-titled EP", "Collector reliquary access", "Token-gated music experiences"],
    "experienceIds": ["voidcaller-legacy-track-0", "voidcaller-legacy-track-1", "voidcaller-legacy-track-2", "voidcaller-legacy-track-3"],
    "marketplaces": [
      {"name": "OPENSEA", "href": "https://opensea.io/collection/voidcaller-avalanche"},
      {"name": "JOEPEGS", "href": "https://joepegs.com/collections/avalanche/voidcaller"}
    ]
  }'::jsonb
FROM contracts c
WHERE c.chain_id = 43114 AND c.address = '0xd1b4367dd9f235f9ee61878019d66e31511e98ee'
ON CONFLICT DO NOTHING;

INSERT INTO tokens (edition_id, contract_id, token_id, metadata)
SELECT 'voidcaller-legacy-edition', c.id, t.token_id, t.metadata
FROM contracts c
CROSS JOIN (VALUES
  (0::numeric, '{"title": "Enough", "art": "/assets/track-art/ep1-enough.png", "previewSrc": "/assets/audio-preview/ep1-04-enough-preview.mp3"}'::jsonb),
  (1::numeric, '{"title": "The Hollow", "art": "/assets/track-art/ep1-the-hollow.png", "previewSrc": "/assets/audio-preview/ep1-01-the-hollow-preview.mp3"}'::jsonb),
  (2::numeric, '{"title": "Don’t Look Down", "art": "/assets/track-art/ep1-dont-look-down.png", "previewSrc": "/assets/audio-preview/ep1-02-dont-look-down-preview.mp3"}'::jsonb),
  (3::numeric, '{"title": "Complex", "art": "/assets/track-art/ep1-complex.png", "previewSrc": "/assets/audio-preview/ep1-03-complex-preview.mp3"}'::jsonb)
) AS t(token_id, metadata)
WHERE c.chain_id = 43114
  AND c.address = '0xd1b4367dd9f235f9ee61878019d66e31511e98ee'
  AND EXISTS (SELECT 1 FROM editions e WHERE e.id = 'voidcaller-legacy-edition')
ON CONFLICT DO NOTHING;

-- One published experience per token. The requirement is the legacy mainnet
-- shape, so server/ownership.js routes it to verifyLegacyMainnetOwnership.
INSERT INTO experiences (id, artist_id, release_id, edition_id, title, description, experience_type, requirements, media_config, version, status)
SELECT
  'voidcaller-legacy-track-' || t.token_id,
  'voidcaller',
  'voidcaller-legacy-genesis',
  'voidcaller-legacy-edition',
  t.title,
  'Full-length “' || t.title || '” for holders of Voidcaller token #' || t.token_id || ' on Avalanche C-Chain.',
  'AUDIO',
  jsonb_build_array(jsonb_build_object(
    'type', 'erc1155-balance',
    'contract', '0xd1b4367dd9f235f9ee61878019d66e31511e98ee',
    'tokenIds', jsonb_build_array(t.token_id::text),
    'minAmount', '1',
    'chainId', 43114
  )),
  '{"protected": true, "protectedMedia": []}'::jsonb,
  1,
  'PUBLISHED'
FROM (VALUES
  (0, 'Enough'),
  (1, 'The Hollow'),
  (2, 'Don’t Look Down'),
  (3, 'Complex')
) AS t(token_id, title)
WHERE EXISTS (SELECT 1 FROM editions e WHERE e.id = 'voidcaller-legacy-edition')
ON CONFLICT DO NOTHING;

COMMIT;
