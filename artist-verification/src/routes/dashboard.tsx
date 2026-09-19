import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Btn, BtnLink, Eyebrow, PageHeader, StatusTag, VerifiedBadge, inputClass } from "@/components/void/atoms";
import {
  claimReviewerSeat,
  getDashboard,
  respondToInformationRequest,
} from "@/lib/verification/server";
import { canApplicantReapply } from "@/lib/verification/status";
import { STATUS_COPY, type DashboardState } from "@/lib/verification/types";

export const Route = createFileRoute("/dashboard")({ component: DashboardPage });

function DashboardPage() {
  const { user, isPending } = useCurrentUserState();
  const [state, setState] = useState<DashboardState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [response, setResponse] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const result = await getDashboard();
    if (!result.ok) {
      setLoadError(result.error.message);
      return;
    }
    setState(result.data);
  }, []);

  useEffect(() => {
    if (!user) return;
    refresh().catch(() => setLoadError("Could not load verification status."));
  }, [user, refresh]);

  if (isPending) {
    return (
      <div className="vc-page">
        <div className="h-12 w-64 animate-pulse bg-ash" />
      </div>
    );
  }
  if (!user) return <RedirectToSignIn />;

  const application = state?.application;
  const profile = state?.profile;
  const status = application?.status;
  const copy = status ? STATUS_COPY[status] : null;

  const onRespond = async () => {
    if (!application) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await respondToInformationRequest({
        data: { applicationId: application.id, response },
      });
      if (!result.ok) {
        setNotice(result.error.message);
        return;
      }
      setResponse("");
      await refresh();
    } catch {
      setNotice("The response could not be stored.");
    } finally {
      setBusy(false);
    }
  };

  const onClaim = async () => {
    setBusy(true);
    try {
      const result = await claimReviewerSeat();
      if (!result.ok) {
        setNotice(result.error.message);
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vc-page">
      <PageHeader eyebrow="† Artist dashboard" title="Verification">
        <p className="m-0 leading-relaxed text-bone-dim">
          {user.displayName || user.primaryEmail || "Signed in"}. Status is read from the stored application — never from the browser.
        </p>
      </PageHeader>

      {loadError && (
        <div role="alert" className="vc-card mb-6 border-crimson text-crimson">
          {loadError}
        </div>
      )}

      <section className="vc-card">
        {!application && (
          <>
            <Eyebrow red>Not applied</Eyebrow>
            <h2 className="mt-3 mb-2 font-display text-[36px] uppercase leading-none">Not applied</h2>
            <p className="mt-0 mb-6 text-bone-dim">Your artist identity has not been submitted for verification.</p>
            <BtnLink to="/verify/apply">Apply for verification</BtnLink>
          </>
        )}

        {application && status === "SUBMITTED" && (
          <>
            <StatusTag status={status} />
            <h2 className="mt-4 mb-2 font-display text-[36px] uppercase leading-none">Submitted</h2>
            <p className="text-bone-dim">{copy?.applicant}</p>
            <Meta application={application} />
          </>
        )}

        {application && status === "UNDER_REVIEW" && (
          <>
            <StatusTag status={status} />
            <h2 className="mt-4 mb-2 font-display text-[36px] uppercase leading-none">Under review</h2>
            <p className="text-bone-dim">{copy?.applicant}</p>
            <Meta application={application} />
          </>
        )}

        {application && status === "NEEDS_INFORMATION" && (
          <>
            <StatusTag status={status} />
            <h2 className="mt-4 mb-2 font-display text-[36px] uppercase leading-none">Needs information</h2>
            <p className="text-bone-dim">{copy?.applicant}</p>
            {application.informationRequest && (
              <blockquote className="my-4 border-l-2 border-crimson pl-4 text-bone">{application.informationRequest}</blockquote>
            )}
            <label className="vc-label">
              Your response
              <textarea className={inputClass()} rows={4} value={response} onChange={(e) => setResponse(e.target.value)} />
            </label>
            {notice && <p className="vc-error">{notice}</p>}
            <div className="mt-4">
              <Btn disabled={busy} onClick={onRespond}>
                {busy ? "Sending…" : "Send response"}
              </Btn>
            </div>
            <Meta application={application} />
          </>
        )}

        {application && status === "VERIFIED" && profile && (
          <>
            <VerifiedBadge />
            <h2 className="mt-4 mb-2 font-display text-[36px] uppercase leading-none">Verified</h2>
            <p className="text-bone-dim">{copy?.applicant}</p>
            {profile.verifiedAt && (
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone-dim">
                Verified {new Date(profile.verifiedAt).toLocaleDateString()}
              </p>
            )}
            <div className="mt-4">
              <BtnLink kind="ghost" to="/artists/$slug" params={{ slug: profile.slug }}>
                View artist profile
              </BtnLink>
            </div>
            <Meta application={application} />
          </>
        )}

        {application && status === "DECLINED" && (
          <>
            <StatusTag status={status} />
            <h2 className="mt-4 mb-2 font-display text-[36px] uppercase leading-none">Declined</h2>
            <p className="text-bone-dim">{copy?.applicant}</p>
            {application.decisionReason && (
              <p className="text-bone">{application.decisionReason}</p>
            )}
            {canApplicantReapply(status) && (
              <div className="mt-4">
                <BtnLink to="/verify/apply">Apply again</BtnLink>
              </div>
            )}
            <Meta application={application} />
          </>
        )}

        {application && status === "REVOKED" && (
          <>
            <StatusTag status={status} />
            <h2 className="mt-4 mb-2 font-display text-[36px] uppercase leading-none">Revoked</h2>
            <p className="text-bone-dim">{copy?.applicant}</p>
            {application.decisionReason && <p className="text-bone">{application.decisionReason}</p>}
            <div className="mt-4">
              <BtnLink to="/verify/apply">Apply again</BtnLink>
            </div>
            <Meta application={application} />
          </>
        )}
      </section>

      {state?.isReviewer && (
        <p className="mt-8 font-mono text-[11px] uppercase tracking-[0.14em] text-bone-dim">
          Reviewer access granted.{" "}
          <Link to="/review" className="text-crimson">
            Open the review queue
          </Link>
        </p>
      )}
      {state?.canClaimReviewerSeat && (
        <div className="mt-8 vc-card">
          <Eyebrow red>Reviewer seat</Eyebrow>
          <p className="mt-3 text-bone-dim">
            No reviewers exist yet. Claiming this seat authorizes this account to review applications. After the first
            reviewer exists, new reviewers must be granted separately.
          </p>
          <Btn disabled={busy} onClick={onClaim}>
            Claim reviewer seat
          </Btn>
        </div>
      )}
    </div>
  );
}

function Meta({
  application,
}: {
  application: NonNullable<DashboardState["application"]>;
}) {
  return (
    <p className="mt-6 mb-0 font-mono text-[11px] uppercase tracking-[0.12em] text-bone-dim">
      {application.publicId}
      {application.submittedAt ? ` · submitted ${new Date(application.submittedAt).toLocaleDateString()}` : ""}
    </p>
  );
}
