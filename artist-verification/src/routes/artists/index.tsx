import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BtnLink, Eyebrow, PageHeader, VerifiedBadge } from "@/components/void/atoms";
import { listVerifiedArtists } from "@/lib/verification/server";
import type { PublicArtist } from "@/lib/verification/types";

export const Route = createFileRoute("/artists/")({ component: ArtistsPage });

function ArtistsPage() {
  const [artists, setArtists] = useState<PublicArtist[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listVerifiedArtists()
      .then((result) => {
        if (!result.ok) {
          setError(result.error.message);
          setArtists([]);
          return;
        }
        setArtists(result.data.artists);
      })
      .catch(() => {
        setError("Could not load verified artists.");
        setArtists([]);
      });
  }, []);

  return (
    <div className="vc-page">
      <PageHeader eyebrow="† Artists" title="Verified artists">
        <p className="m-0 leading-relaxed text-bone-dim">
          Only identities whose application status is VERIFIED appear here. The mark is not a fixture.
        </p>
      </PageHeader>
      {error && (
        <div role="alert" className="vc-card mb-6 border-crimson text-crimson">
          {error}
        </div>
      )}
      {artists === null && <div className="h-40 animate-pulse bg-abyss" />}
      {artists && artists.length === 0 && !error && (
        <div className="vc-card">
          <Eyebrow>Empty ledger</Eyebrow>
          <p className="mt-3 text-bone-dim">No verified artists yet.</p>
          <BtnLink to="/verify">Become verified</BtnLink>
        </div>
      )}
      {artists && artists.length > 0 && (
        <div className="vc-market-grid">
          {artists.map((artist) => (
            <Link
              key={artist.slug}
              to="/artists/$slug"
              params={{ slug: artist.slug }}
              className="vc-card text-inherit no-underline hover:border-smoke"
            >
              <VerifiedBadge compact />
              <h2 className="mt-4 mb-2 font-display text-[32px] uppercase leading-none">{artist.artistName}</h2>
              <p className="m-0 font-mono text-[11px] uppercase tracking-[0.14em] text-crimson">
                {artist.artistType}
              </p>
              <p className="mt-3 mb-0 line-clamp-3 text-sm leading-relaxed text-bone-dim">{artist.artistBio}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
