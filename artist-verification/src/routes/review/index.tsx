import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Btn, Eyebrow, PageHeader, StatusTag } from "@/components/void/atoms";
import { claimReviewerSeat, listReviewQueue } from "@/lib/verification/server";
import type { ReviewerApplication } from "@/lib/verification/types";

export const Route = createFileRoute("/review/")({ component: ReviewQueue });

function ReviewQueue() {
  const { user, isPending } = useCurrentUserState();
  const [apps, setApps] = useState<ReviewerApplication[]>([]);
  const [canClaim, setCanClaim] = useState(false);
  const [isReviewer, setIsReviewer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const result = await listReviewQueue();
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setApps(result.data.applications);
    setCanClaim(result.data.canClaim);
    setIsReviewer(result.data.isReviewer);
  };

  useEffect(() => {
    if (!user) return;
    load().catch(() => setError("Could not load the review queue."));
  }, [user]);

  if (isPending) return <div className="vc-page"><div className="h-12 w-48 animate-pulse bg-ash" /></div>;
  if (!user) return <RedirectToSignIn />;

  const onClaim = async () => {
    setBusy(true);
    try {
      const result = await claimReviewerSeat();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setCanClaim(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vc-page">
      <PageHeader eyebrow="† Review" title="Applications">
        <p className="m-0 leading-relaxed text-bone-dim">
          Reviewer-only. Notes stay internal. Applicants never receive the private ledger.
        </p>
      </PageHeader>
      {error && (
        <div role="alert" className="vc-card mb-6 border-crimson text-crimson">
          {error}
        </div>
      )}
      {canClaim && (
        <div className="vc-card mb-6">
          <Eyebrow red>Empty seat</Eyebrow>
          <p className="text-bone-dim">No reviewers exist yet. Claim the first seat to open the queue.</p>
          <Btn disabled={busy} onClick={onClaim}>
            Claim reviewer seat
          </Btn>
        </div>
      )}
      {!canClaim && !isReviewer && (
        <div className="vc-card">
          <Eyebrow red>Restricted</Eyebrow>
          <p className="text-bone-dim">Reviewer authorization is required to open this queue.</p>
        </div>
      )}
      {!canClaim && isReviewer && apps.length === 0 && (
        <div className="vc-card">
          <Eyebrow>Queue</Eyebrow>
          <p className="text-bone-dim">No applications in the ledger.</p>
        </div>
      )}
      <div className="flex flex-col gap-3">
        {apps.map((app) => (
          <Link
            key={app.id}
            to="/review/$id"
            params={{ id: app.id }}
            className="vc-card flex flex-wrap items-center justify-between gap-4 text-inherit no-underline hover:border-smoke"
          >
            <div>
              <p className="m-0 font-display text-[28px] uppercase leading-none">{app.artistName}</p>
              <p className="mt-2 mb-0 font-mono text-[11px] uppercase tracking-[0.12em] text-bone-dim">
                {app.publicId} · {app.artistType} · {app.location}
              </p>
            </div>
            <StatusTag status={app.status} />
          </Link>
        ))}
      </div>
    </div>
  );
}
