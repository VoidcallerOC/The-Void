import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Btn, Eyebrow, PageHeader, StatusTag, inputClass } from "@/components/void/atoms";
import { getReviewApplication, reviewApplication } from "@/lib/verification/server";
import type { ApplicationStatus, ReviewerApplication } from "@/lib/verification/types";

export const Route = createFileRoute("/review/$id")({ component: ReviewDetail });

const ACTIONS: { status: ApplicationStatus; label: string }[] = [
  { status: "UNDER_REVIEW", label: "Begin review" },
  { status: "NEEDS_INFORMATION", label: "Request information" },
  { status: "VERIFIED", label: "Approve verification" },
  { status: "DECLINED", label: "Decline" },
  { status: "REVOKED", label: "Revoke" },
];

function ReviewDetail() {
  const { id } = Route.useParams();
  const { user, isPending } = useCurrentUserState();
  const [app, setApp] = useState<ReviewerApplication | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const result = await getReviewApplication({ data: { id } });
    if (!result.ok) {
      setError(result.error.message);
      setApp(null);
      return;
    }
    setApp(result.data.application);
    setNotes(result.data.application.reviewNotes ?? "");
  };

  useEffect(() => {
    if (!user) return;
    load().catch(() => setError("Application not found."));
  }, [user, id]);

  if (isPending) return <div className="vc-page"><div className="h-12 w-48 animate-pulse bg-ash" /></div>;
  if (!user) return <RedirectToSignIn />;

  const decide = async (status: ApplicationStatus) => {
    if (!app) return;
    setBusy(status);
    setError(null);
    try {
      const result = await reviewApplication({
        data: {
          applicationId: app.id,
          status,
          reviewNotes: notes,
          decisionReason: reason,
          informationRequest: request,
        },
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setApp(result.data.application);
    } catch {
      setError("The decision could not be stored.");
    } finally {
      setBusy(null);
    }
  };

  const links = app
    ? [
        ["Website", app.websiteUrl],
        ["Instagram", app.instagramUrl],
        ["TikTok", app.tiktokUrl],
        ["YouTube", app.youtubeUrl],
        ["Spotify", app.spotifyUrl],
        ["Apple Music", app.appleMusicUrl],
        ["SoundCloud", app.soundcloudUrl],
        ["Bandcamp", app.bandcampUrl],
        ["Other", app.otherUrl],
        ["Portfolio", app.portfolioUrl],
        ...app.workUrls.map((url, i) => [`Work ${i + 1}`, url] as const),
      ].filter((entry): entry is [string, string] => Boolean(entry[1]))
    : [];

  return (
    <div className="vc-page">
      <Link to="/review" className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone-dim hover:text-crimson">
        ← Queue
      </Link>
      <PageHeader eyebrow="† Reviewer" title={app?.artistName || "Application"}>
        {app && <StatusTag status={app.status} />}
      </PageHeader>
      {error && (
        <div role="alert" className="vc-card mb-6 border-crimson text-crimson">
          {error}
        </div>
      )}
      {!app && !error && <div className="h-40 animate-pulse bg-abyss" />}
      {app && (
        <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="flex flex-col gap-4">
            <section className="vc-card">
              <Eyebrow red>Applicant</Eyebrow>
              <p className="mt-3 mb-1">{app.legalName}</p>
              <p className="m-0 font-mono text-[12px] text-bone-dim">{app.email}</p>
              <p className="m-0 font-mono text-[12px] text-bone-dim">
                {app.artistType} · {app.location} · {app.yearsActive}
              </p>
              <p className="mt-4 leading-relaxed text-bone-dim">{app.artistBio}</p>
              <p className="leading-relaxed text-bone-dim">{app.workDescription}</p>
            </section>
            <section className="vc-card">
              <Eyebrow red>Evidence</Eyebrow>
              <p className="mt-4 whitespace-pre-wrap leading-relaxed">{app.verificationEvidence}</p>
              {app.additionalInformation && (
                <p className="whitespace-pre-wrap text-bone-dim">{app.additionalInformation}</p>
              )}
              {app.applicantResponse && (
                <>
                  <Eyebrow style={{ marginTop: 20 }}>Applicant response</Eyebrow>
                  <p className="whitespace-pre-wrap">{app.applicantResponse}</p>
                </>
              )}
              <ul className="mt-4 list-none space-y-2 p-0">
                {links.map(([label, href]) => (
                  <li key={label}>
                    <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono text-[12px] text-crimson hover:underline">
                      {label} ↗
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <aside className="vc-card h-fit">
            <Eyebrow red>Decision</Eyebrow>
            <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.12em] text-bone-dim">{app.publicId}</p>
            <label className="vc-label">
              Internal review notes
              <textarea className={inputClass()} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            <label className="vc-label">
              Decision reason (visible to applicant)
              <textarea className={inputClass()} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <label className="vc-label">
              Information request
              <textarea className={inputClass()} rows={3} value={request} onChange={(e) => setRequest(e.target.value)} />
            </label>
            <div className="mt-5 flex flex-col gap-2">
              {ACTIONS.map((action) => (
                <Btn
                  key={action.status}
                  kind={action.status === "VERIFIED" ? "primary" : "ghost"}
                  disabled={busy !== null}
                  onClick={() => decide(action.status)}
                >
                  {busy === action.status ? "Saving…" : action.label}
                </Btn>
              ))}
            </div>
            <p className="mt-4 mb-0 font-mono text-[10px] uppercase tracking-[0.12em] text-bone-dim">
              Review notes never leave this panel.
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}
