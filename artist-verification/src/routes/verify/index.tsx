import { createFileRoute } from "@tanstack/react-router";
import { BtnLink, Eyebrow } from "@/components/void/atoms";

export const Route = createFileRoute("/verify/")({ component: VerifyLanding });

function VerifyLanding() {
  return (
    <>
      <section className="vc-hero-bleed">
        <div className="vc-hero-copy">
          <Eyebrow red>† Artist verification</Eyebrow>
          <h1 className="vc-hero-title mt-4 mb-0 max-w-[12ch] text-bone">Become verified</h1>
          <p className="mt-5 max-w-[640px] text-[17px] leading-[1.7] text-bone-dim">
            Establish your identity. Authenticate your work. Become a verified artist within The Void.
          </p>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <BtnLink to="/verify/apply">Apply for verification</BtnLink>
            <BtnLink kind="ghost" to="/dashboard">
              View application status
            </BtnLink>
          </div>
        </div>
      </section>

      <div className="vc-page">
        <div className="grid gap-8 md:grid-cols-2">
          <article>
            <Eyebrow red>What it is</Eyebrow>
            <h2 className="mt-3 mb-3 font-display text-[36px] uppercase leading-none">Control, not blessing</h2>
            <p className="m-0 leading-[1.7] text-bone-dim">
              Artist verification establishes that an artist identity is controlled by the person or team representing it.
              Verification does not constitute an endorsement of the artist, their work, or their commercial activity.
            </p>
          </article>
          <article>
            <Eyebrow>The chain</Eyebrow>
            <ol className="mt-4 mb-0 list-none space-y-3 p-0 font-mono text-[12px] uppercase tracking-[0.12em] text-bone">
              {[
                "01  Sign in",
                "02  Submit an application",
                "03  Human review",
                "04  Decision",
                "05  Verified artist mark",
              ].map((step) => (
                <li key={step} className="border-l border-ash pl-4">
                  {step}
                </li>
              ))}
            </ol>
          </article>
        </div>

        <div className="mt-12 vc-card">
          <Eyebrow red>Do not overpromise</Eyebrow>
          <p className="mt-3 mb-0 max-w-[720px] leading-relaxed text-bone-dim">
            A verified mark means a reviewer accepted evidence that you control the named identity. It is not a ranking,
            a booking, a distribution deal, or a guarantee of collection. False or unverifiable claims are declined.
          </p>
        </div>
      </div>
    </>
  );
}
