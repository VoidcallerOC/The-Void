import { createFileRoute } from "@tanstack/react-router";
import { BtnLink, Eyebrow, PageHeader, StatusTag } from "@/components/void/atoms";

type Search = {
  id: string;
  name: string;
  status: string;
  submitted: string;
};

export const Route = createFileRoute("/verify/received")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    id: typeof search.id === "string" ? search.id : "",
    name: typeof search.name === "string" ? search.name : "",
    status: typeof search.status === "string" ? search.status : "SUBMITTED",
    submitted: typeof search.submitted === "string" ? search.submitted : "",
  }),
  component: ReceivedPage,
});

function ReceivedPage() {
  const { id, name, status, submitted } = Route.useSearch();
  const when = submitted
    ? new Date(submitted).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "just now";

  return (
    <div className="vc-page max-w-[720px]">
      <PageHeader eyebrow="† Received" title="Application received">
        <p className="m-0 leading-relaxed text-bone-dim">
          Your Artist Verification application has been submitted.
        </p>
      </PageHeader>
      <div className="vc-card">
        <Eyebrow red>{name || "Artist"}</Eyebrow>
        <dl className="mt-6 grid gap-4 font-mono text-[12px] uppercase tracking-[0.12em]">
          <div>
            <dt className="text-bone-dim">Application ID</dt>
            <dd className="mt-1 text-bone">{id || "—"}</dd>
          </div>
          <div>
            <dt className="text-bone-dim">Status</dt>
            <dd className="mt-2">
              <StatusTag status={status || "SUBMITTED"} />
            </dd>
          </div>
          <div>
            <dt className="text-bone-dim">Submitted</dt>
            <dd className="mt-1 text-bone">{when}</dd>
          </div>
        </dl>
      </div>
      <div className="mt-6 flex flex-wrap gap-2.5">
        <BtnLink to="/dashboard">View application status</BtnLink>
        <BtnLink kind="ghost" to="/">
          Return to The Void
        </BtnLink>
      </div>
    </div>
  );
}
