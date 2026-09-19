import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { GROK_PROVIDERS, authClient, authEnabled, signIn } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Btn, Eyebrow, PageHeader, inputClass } from "@/components/void/atoms";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  const navigate = useNavigate();
  const { user, isPending } = useCurrentUserState();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isPending && user) {
    void navigate({ to: "/dashboard" });
  }

  const onEmail = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") {
        const result = await authClient.signUp.email({ email, password, name: name || email.split("@")[0] });
        if (result.error) throw new Error(result.error.message || "Could not create the account.");
      } else {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) throw new Error(result.error.message || "Could not sign in.");
      }
      await navigate({ to: "/dashboard" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="vc-page max-w-[520px]">
      <PageHeader eyebrow="† Account" title="Sign in">
        <p className="m-0 leading-relaxed text-bone-dim">
          Applications are bound to the signed-in account. Wallet authentication from the production Void stack is not attached here — this environment uses The Void account session.
        </p>
      </PageHeader>

      {!authEnabled ? (
        <p className="text-bone-dim">Sign-in is disabled.</p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {GROK_PROVIDERS.map((p) => (
              <button
                key={p.providerId}
                type="button"
                onClick={() => signIn(p.providerId, { callbackURL: "/dashboard" })}
                className="min-h-11 w-full border border-bone px-4 py-3 font-body text-xs font-bold uppercase tracking-[0.18em] text-bone hover:border-crimson hover:text-crimson"
              >
                Continue with {p.label}
              </button>
            ))}
          </div>

          <div className="my-8 flex items-center gap-4">
            <span className="h-px flex-1 bg-ash" />
            <Eyebrow>or email</Eyebrow>
            <span className="h-px flex-1 bg-ash" />
          </div>

          <form onSubmit={onEmail} className="vc-card">
            {error && (
              <div role="alert" className="mb-3 font-mono text-[12px] text-crimson">
                {error}
              </div>
            )}
            {mode === "signup" && (
              <label className="vc-label">
                Name
                <input className={inputClass()} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </label>
            )}
            <label className="vc-label">
              Email
              <input className={inputClass()} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            </label>
            <label className="vc-label">
              Password
              <input
                className={inputClass()}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                minLength={8}
                required
              />
            </label>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Btn type="submit" disabled={busy}>
                {busy ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
              </Btn>
              <button
                type="button"
                className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone-dim underline"
                onClick={() => setMode(mode === "signup" ? "signin" : "signup")}
              >
                {mode === "signup" ? "Have an account? Sign in" : "Need an account? Create one"}
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
