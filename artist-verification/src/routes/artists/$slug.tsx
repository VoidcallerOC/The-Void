import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Eyebrow, PageHeader, VerifiedBadge } from "@/components/void/atoms";
import { getPublicArtist } from "@/lib/verification/server";
import type { PublicArtist } from "@/lib/verification/types";

export const Route = createFileRoute("/artists/$slug")({ component: ArtistProfile });

function ArtistProfile() {
  const { slug } = Route.useParams();
  const [artist, setArtist] = useState<PublicArtist | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPublicArtist({ data: { slug } })
      .then((result) => {
        if (!result.ok) {
          setError(result.error.message);
          setArtist(null);
          return;
        }
        setArtist(result.data.artist);
      })
      .catch(() => setError("Artist not found."));
  }, [slug]);

  if (error) {
    return (
      <div className="vc-page">
        <PageHeader eyebrow="† Artist" title="Not found">
          <p className="text-bone-dim">{error}</p>
          <Link to="/artists" className="text-crimson">
            Return to artists
          </Link>
        </PageHeader>
      </div>
    );
  }

  if (!artist) {
    return (
      <div className="vc-page">
        <div className="h-40 animate-pulse bg-abyss" />
      </div>
    );
  }

  const links = [
    ["Website", artist.websiteUrl],
    ["Instagram", artist.instagramUrl],
    ["TikTok", artist.tiktokUrl],
    ["YouTube", artist.youtubeUrl],
    ["Spotify", artist.spotifyUrl],
    ["Apple Music", artist.appleMusicUrl],
    ["SoundCloud", artist.soundcloudUrl],
    ["Bandcamp", artist.bandcampUrl],
    ["Other", artist.otherUrl],
    ["Portfolio", artist.portfolioUrl],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  return (
    <div className="vc-page">
      <div className="vc-card mb-8 min-h-[220px] bg-gradient-to-b from-clot to-abyss">
        {artist.isVerified ? <VerifiedBadge /> : <Eyebrow>Artist</Eyebrow>}
        <h1
          className="mt-4 mb-1 font-display uppercase"
          style={{ fontSize: "clamp(52px, 10vw, 100px)", lineHeight: 0.9 }}
        >
          {artist.artistName}
        </h1>
        <p className="m-0 font-mono text-[12px] uppercase tracking-[0.16em] text-bone-dim">
          {artist.artistType} · {artist.location}
          {artist.verifiedAt ? ` · verified ${new Date(artist.verifiedAt).toLocaleDateString()}` : ""}
        </p>
      </div>
      <p className="max-w-[650px] leading-[1.7] text-bone-dim">{artist.artistBio}</p>
      <p className="max-w-[650px] leading-[1.7] text-bone-dim">{artist.workDescription}</p>
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone-dim">Years active · {artist.yearsActive}</p>
      {links.length > 0 && (
        <div className="mt-8 flex flex-wrap gap-4">
          {links.map(([label, href]) => (
            <a key={label} href={href} target="_blank" rel="noopener noreferrer" className="font-body text-sm text-bone underline-offset-4 hover:text-crimson hover:underline">
              {label}
            </a>
          ))}
        </div>
      )}
      {artist.workUrls.length > 0 && (
        <div className="mt-10">
          <Eyebrow>Work</Eyebrow>
          <ul className="mt-3 list-none space-y-2 p-0">
            {artist.workUrls.map((url) => (
              <li key={url}>
                <a href={url} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-[12px] text-bone-dim hover:text-crimson">
                  {url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
