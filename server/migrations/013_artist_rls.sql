BEGIN;

-- Row Level Security for the artist domain tables.
--
-- The Render API connects as the postgres (superuser) role via DATABASE_URL
-- and bypasses RLS. These policies lock down Supabase PostgREST access
-- through the anon and authenticated roles.
--
-- FORCE ROW LEVEL SECURITY is intentionally not set so the service-role
-- connection continues to operate without restriction.

-- === public.artists ===
ALTER TABLE artists ENABLE ROW LEVEL SECURITY;

-- Public catalog: anon and authenticated may read ACTIVE artists.
-- application_metadata is included because the public API (GET /api/artists)
-- already returns it and the frontend reads profileArtwork/artwork/banner
-- from it via catalog-source.js.
CREATE POLICY artists_select_active ON artists
  FOR SELECT TO anon, authenticated
  USING (status = 'ACTIVE');

-- No INSERT/UPDATE/DELETE policies for anon or authenticated.
-- All mutations are performed by the server's superuser connection.

-- === public.artist_profiles ===
ALTER TABLE artist_profiles ENABLE ROW LEVEL SECURITY;

-- Public catalog: profiles are visible when the parent artist is ACTIVE.
-- profile_metadata is included because the public API selects it and the
-- frontend reads profileArtwork from it.
CREATE POLICY artist_profiles_select_active ON artist_profiles
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM artists
      WHERE artists.id = artist_profiles.artist_id
        AND artists.status = 'ACTIVE'
    )
  );

-- No INSERT/UPDATE/DELETE policies for anon or authenticated.

-- === public.artist_owners ===
ALTER TABLE artist_owners ENABLE ROW LEVEL SECURITY;

-- No policies. Wallet-to-artist ownership mapping is security-sensitive
-- internal state. All access is through the server's superuser connection.

COMMIT;
