import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { ApplicationForm } from "@/components/void/application-form";
import { BtnLink, PageHeader } from "@/components/void/atoms";
import { getDashboard, submitApplication } from "@/lib/verification/server";
import { canApplicantReapply } from "@/lib/verification/status";
import type { ApplicationInput, FieldErrors } from "@/lib/verification/types";

export const Route = createFileRoute("/verify/apply")({ component: ApplyPage });

function ApplyPage() {
  const navigate = useNavigate();
  const { user, isPending } = useCurrentUserState();
  const [blocked, setBlocked] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!user) return;
    getDashboard()
      .then((result) => {
        if (!result.ok) {
          setFormError(result.error.message);
          return;
        }
        const current = result.data.application;
        if (current && !canApplicantReapply(current.status)) {
          setBlocked(
            current.status === "VERIFIED"
              ? "This account already holds a verified artist identity."
              : "An application for this account is already in progress.",
          );
        }
      })
      .catch(() => setFormError("Could not load your existing application."))
      .finally(() => setReady(true));
  }, [user]);

  if (isPending) {
    return (
      <div className="vc-page">
        <div className="h-10 w-48 animate-pulse bg-ash" />
      </div>
    );
  }
  if (!user) return <RedirectToSignIn />;

  const onSubmit = async (value: ApplicationInput) => {
    setSubmitting(true);
    setErrors({});
    setFormError(null);
    try {
      const result = await submitApplication({ data: value });
      if (!result.ok) {
        setErrors(result.error.fields ?? {});
        setFormError(result.error.message);
        return;
      }
      await navigate({
        to: "/verify/received",
        search: {
          id: result.data.application.publicId,
          name: result.data.application.artistName,
          status: result.data.application.status,
          submitted: result.data.application.submittedAt ?? "",
        },
      });
    } catch (error) {
      const message = error instanceof Error && error.message === "Unauthorized" ? "Sign in to continue." : "The application could not be stored.";
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="vc-page">
      <PageHeader eyebrow="† Application" title="Apply">
        <p className="m-0 leading-relaxed text-bone-dim">
          Bound to {user.primaryEmail || user.displayName || "this account"}. Reviewers will use the evidence you provide
          to confirm control of the identity.
        </p>
      </PageHeader>

      {blocked ? (
        <div className="vc-card">
          <p className="mt-0 mb-4 text-bone-dim">{blocked}</p>
          <BtnLink to="/dashboard">View application status</BtnLink>
        </div>
      ) : ready ? (
        <ApplicationForm
          defaultEmail={user.primaryEmail}
          submitting={submitting}
          errors={errors}
          formError={formError}
          onSubmit={onSubmit}
        />
      ) : (
        <div className="vc-card h-40 animate-pulse" />
      )}
    </div>
  );
}
