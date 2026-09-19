import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BtnLink, Eyebrow, VerifiedBadge } from "@/components/void/atoms";
import { listVerifiedArtists } from "@/lib/verification/server";
import type { PublicArtist } from "@/lib/verification/types";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const [artists, setArtists] = useState<PublicArtist[]>([]);

  useEffect(() => {
    listVerifiedArtists()
      .then((result) => {
        if (result.ok) setArtists(result.data.artists);
      })
      .catch(() => setArtists([]));
  }, []);

  return (
    <>
      <section className="vc-hero-bleed">
        <div className="vc-hero-copy">
          <Eyebrow red>† The Void</Eyebrow>
          <h1 className="vc-hero-title mt-4 mb-0 max-w-[14ch] text-bone">Become verified</h1>
          <p className="mt-5 max-w-[620px] text-[17px] leading-[1.7] text-bone-dim">
            Establish your identity. Authenticate your work. Become a verified artist within The Void.
          </p>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <BtnLink to="/verify">Apply for verification</BtnLink>
            <BtnLink kind="ghost" to="/artists">
              View verified artists
            </BtnLink>
          </div>
        </div>
      </section>

      <div className="vc-page">
        <div className="grid gap-4 md:grid-cols-3">
          {[
            ["Identity", "Verification establishes that an artist identity is controlled by the person or team representing it."],
            ["Review", "Applications are stored, reviewed, and decided. Status is never a client-side fixture."],
            ["The mark", "Approved identities carry the verified artist mark on their Void profile."],
          ].map(([title, copy]) => (
            <article key={title} className="vc-card">
              <Eyebrow red>{title}</Eyebrow>
              <p className="mt-3 mb-0 leading-relaxed text-bone-dim">{copy}</p>
            </article>
          ))}
        </div>

        <p className="mt-10 max-w-[720px] text-[14px] leading-relaxed text-bone-dim">
          Artist verification does not constitute an endorsement of the artist, their work, or their commercial activity.
          It records control of identity — nothing more.
        </p>

        <h2 className="mt-16 mb-5 font-display uppercase" style={{ fontSize: "clamp(28px, 4vw, 42px)" }}>
          Verified on The Void
        </h2>
        {artists.length === 0 ? (
          <div className="vc-card">
            <Eyebrow>None yet</Eyebrow>
            <p className="mt-3 mb-0 text-bone-dim">No verified artists have been approved. The first mark is still unclaimed.</p>
          </div>
        ) : (
          <div className="vc-market-grid">
            {artists.slice(0, 6).map((artist) => (
              <Link
                key={artist.slug}
                to="/artists/$slug"
                params={{ slug: artist.slug }}
                className="vc-card text-inherit no-underline transition-[border-color] duration-200 hover:border-smoke"
              >
                <VerifiedBadge compact />
                <h3 className="mt-4 mb-1 font-display text-[32px] uppercase leading-none">{artist.artistName}</h3>
                <p className="m-0 font-mono text-[11px] uppercase tracking-[0.14em] text-bone-dim">
                  {artist.artistType} · {artist.location}
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
