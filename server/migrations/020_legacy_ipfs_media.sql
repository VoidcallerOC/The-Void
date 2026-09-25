BEGIN;

-- Point the four legacy Voidcaller tokens (seeded by 019) at the art and full
-- audio that are already public on IPFS through their on-chain metadata.
-- 019 was applied to the live database before this change, so it stays
-- untouched and this migration updates its rows instead.
--
-- Source of truth: uri(id) on 0xd1b4367dd9f235f9ee61878019d66e31511e98ee
-- (Avalanche C-Chain, 43114) is
-- ipfs://bafybeigft5uayq6i6ada64mc33if7yxs74kfes7pxa3a7umjr2s6njdxte/{id}.
-- The image and animation_url values below were read from that metadata and
-- match src/lib/legacy-genesis.js (LEGACY_IPFS_MEDIA).
--
-- That audio is public by design. Anyone holding the CID can play it. The
-- holder gate on these experiences decides who gets the in-app experience. It
-- does not keep the files secret. No repo audio path or Pinata private object
-- is referenced here.
--
-- Data only. Every UPDATE is guarded so re-running this body is a no-op and
-- later Studio edits (new artwork, attached Pinata assets) are never
-- overwritten.

-- Release: token artwork on each track plus a cover. The gateway form is what
-- the frontend renders. The ipfs:// form is kept alongside it as the canonical
-- reference.
UPDATE releases
SET release_metadata = release_metadata || jsonb_build_object(
      'artwork', 'https://gateway.pinata.cloud/ipfs/QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.gif',
      'artworkUri', 'ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.gif',
      'tracks', '[
        {"n": "01", "title": "The Hollow", "time": "3:57", "tokenId": 1, "previewSrc": "/assets/audio-preview/ep1-01-the-hollow-preview.mp3", "art": "https://gateway.pinata.cloud/ipfs/QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.gif", "artUri": "ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.gif", "experienceId": "voidcaller-legacy-track-1"},
        {"n": "02", "title": "Don’t Look Down", "time": "4:20", "tokenId": 2, "previewSrc": "/assets/audio-preview/ep1-02-dont-look-down-preview.mp3", "art": "https://gateway.pinata.cloud/ipfs/QmeR8MoKr3PYDUVvVy1PzhXzBNPFtNZjoioGMBapYqBePs", "artUri": "ipfs://QmeR8MoKr3PYDUVvVy1PzhXzBNPFtNZjoioGMBapYqBePs", "experienceId": "voidcaller-legacy-track-2"},
        {"n": "03", "title": "Complex", "time": "5:08", "tokenId": 3, "previewSrc": "/assets/audio-preview/ep1-03-complex-preview.mp3", "art": "https://gateway.pinata.cloud/ipfs/bafybeic2idq4wqbh5kt7sibfypedj4mejgvos2mh76x2wk3ezxuiljxjaa/3.gif", "artUri": "ipfs://bafybeic2idq4wqbh5kt7sibfypedj4mejgvos2mh76x2wk3ezxuiljxjaa/3.gif", "experienceId": "voidcaller-legacy-track-3"},
        {"n": "04", "title": "Enough", "time": "4:46", "tokenId": 0, "previewSrc": "/assets/audio-preview/ep1-04-enough-preview.mp3", "art": "https://gateway.pinata.cloud/ipfs/QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/0.gif", "artUri": "ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/0.gif", "experienceId": "voidcaller-legacy-track-0"}
      ]'::jsonb
    ),
    updated_at = now()
WHERE id = 'voidcaller-legacy-genesis'
  AND release_metadata->>'artwork' = '/assets/voidcaller_art_4.png';

UPDATE editions
SET application_metadata = application_metadata || jsonb_build_object(
      'artwork', 'https://gateway.pinata.cloud/ipfs/QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.gif',
      'artworkUri', 'ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.gif'
    ),
    updated_at = now()
WHERE id = 'voidcaller-legacy-edition'
  AND application_metadata->>'artwork' = '/assets/voidcaller_art_4.png';

-- Tokens: the on-chain metadata URI, plus the image and animation_url from that
-- metadata. Public API responses never include token rows.
UPDATE tokens t
SET metadata_uri = COALESCE(t.metadata_uri, 'ipfs://bafybeigft5uayq6i6ada64mc33if7yxs74kfes7pxa3a7umjr2s6njdxte/' || t.token_id::text),
    metadata = COALESCE(t.metadata, '{}'::jsonb) || jsonb_build_object(
      'image', m.image,
      'animation_url', m.animation_url,
      'art', 'https://gateway.pinata.cloud/ipfs/' || substring(m.image FROM 8),
      'artUri', m.image
    ),
    updated_at = now()
FROM contracts c,
  (VALUES
    (0::numeric, 'ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/0.gif', 'ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/0.mp3'),
    (1::numeric, 'ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.gif', 'ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.mp3'),
    (2::numeric, 'ipfs://QmeR8MoKr3PYDUVvVy1PzhXzBNPFtNZjoioGMBapYqBePs', 'ipfs://QmT4MVGxkxaxyQWn2Hk7LZVEALGDykVqcaWecx5KNV3Hkn'),
    (3::numeric, 'ipfs://bafybeic2idq4wqbh5kt7sibfypedj4mejgvos2mh76x2wk3ezxuiljxjaa/3.gif', 'ipfs://bafybeic2idq4wqbh5kt7sibfypedj4mejgvos2mh76x2wk3ezxuiljxjaa/3.wav')
  ) AS m(token_id, image, animation_url)
WHERE t.contract_id = c.id
  AND c.chain_id = 43114
  AND c.address = '0xd1b4367dd9f235f9ee61878019d66e31511e98ee'
  AND t.edition_id = 'voidcaller-legacy-edition'
  AND t.token_id = m.token_id
  AND NOT (COALESCE(t.metadata, '{}'::jsonb) ? 'image');

-- Experiences: full audio is the token's own animation_url, delivered through
-- the normal grant flow. The media gateway accepts a public-ipfs source only
-- for these exact URIs, and only on an experience gated by the legacy mainnet
-- requirement for the same token (server/media-gateway.js). Rows are updated
-- only while protectedMedia is still empty, so a Pinata asset attached in the
-- Studio is never replaced.
UPDATE experiences x
SET media_config = x.media_config || jsonb_build_object(
      'protected', true,
      'protectedMedia', jsonb_build_array(jsonb_build_object(
        'mediaType', 'AUDIO',
        'source', 'public-ipfs',
        'uri', m.animation_url,
        'contentType', m.content_type
      )),
      'artwork', 'https://gateway.pinata.cloud/ipfs/' || substring(m.image FROM 8),
      'artworkUri', m.image
    ),
    updated_at = now()
FROM (VALUES
    ('voidcaller-legacy-track-0', 'ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/0.gif', 'ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/0.mp3', 'audio/wav'),
    ('voidcaller-legacy-track-1', 'ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.gif', 'ipfs://QmfCKKX55HdmKw6cFiM1qCFeLhXc3UNrs3rmHfG8CjMbJP/1.mp3', 'audio/mpeg'),
    ('voidcaller-legacy-track-2', 'ipfs://QmeR8MoKr3PYDUVvVy1PzhXzBNPFtNZjoioGMBapYqBePs', 'ipfs://QmT4MVGxkxaxyQWn2Hk7LZVEALGDykVqcaWecx5KNV3Hkn', 'audio/wav'),
    ('voidcaller-legacy-track-3', 'ipfs://bafybeic2idq4wqbh5kt7sibfypedj4mejgvos2mh76x2wk3ezxuiljxjaa/3.gif', 'ipfs://bafybeic2idq4wqbh5kt7sibfypedj4mejgvos2mh76x2wk3ezxuiljxjaa/3.wav', 'audio/wav')
  ) AS m(experience_id, image, animation_url, content_type)
WHERE x.id = m.experience_id
  AND x.artist_id = 'voidcaller'
  AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(x.media_config->'protectedMedia') = 'array' THEN x.media_config->'protectedMedia' END), 0) = 0;

COMMIT;
