import { Link, type LinkProps } from "@tanstack/react-router";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { Check } from "lucide-react";

export function Eyebrow({
  children,
  red,
  style,
}: {
  children: ReactNode;
  red?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      className="font-mono text-[11px] uppercase tracking-[0.18em]"
      style={{ color: red ? "var(--vc-crimson)" : "var(--vc-bone-dim)", ...style }}
    >
      {children}
    </div>
  );
}

type BtnKind = "primary" | "ghost" | "ash";

export function Btn({
  kind = "primary",
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind }) {
  const base =
    "inline-flex items-center justify-center min-h-11 px-[22px] py-3.5 font-body font-bold text-xs tracking-[0.2em] uppercase border transition-[background-color,border-color,color,box-shadow,transform] duration-120 disabled:cursor-not-allowed disabled:text-bone/30 disabled:border-bone/15 disabled:bg-transparent disabled:shadow-none";
  const variants: Record<BtnKind, string> = {
    primary:
      "bg-crimson border-crimson text-skull shadow-[0_0_32px_-8px_rgba(225,15,31,0.55)] hover:bg-ember hover:border-ember",
    ghost: "bg-transparent border-bone text-bone hover:text-crimson hover:border-crimson",
    ash: "bg-transparent border-ash text-bone-dim hover:text-bone hover:border-smoke",
  };
  return (
    <button type="button" className={`${base} ${variants[kind]} ${className ?? ""}`} {...props}>
      {children}
    </button>
  );
}

export function BtnLink({
  kind = "primary",
  children,
  className,
  ...props
}: LinkProps & { kind?: BtnKind; children: ReactNode; className?: string }) {
  const base =
    "inline-flex items-center justify-center min-h-11 px-[22px] py-3.5 font-body font-bold text-xs tracking-[0.2em] uppercase border no-underline";
  const variants: Record<BtnKind, string> = {
    primary: "bg-crimson border-crimson text-skull shadow-[0_0_32px_-8px_rgba(225,15,31,0.55)]",
    ghost: "bg-transparent border-bone text-bone",
    ash: "bg-transparent border-ash text-bone-dim",
  };
  return (
    <Link className={`${base} ${variants[kind]} ${className ?? ""}`} {...props}>
      {children}
    </Link>
  );
}

export function VerifiedBadge({ compact }: { compact?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 border border-crimson bg-blood px-2.5 py-1 font-body font-bold uppercase tracking-[0.18em] text-skull"
      style={{ fontSize: compact ? 9 : 10 }}
    >
      <Check size={12} strokeWidth={3} />
      Verified artist
    </span>
  );
}

export function StatusTag({
  status,
}: {
  status: string;
}) {
  const tone =
    status === "VERIFIED"
      ? "border-crimson bg-blood text-skull"
      : status === "DECLINED" || status === "REVOKED"
        ? "border-ash text-bone-dim"
        : "border-crimson text-crimson bg-transparent";
  const label = status.replaceAll("_", " ");
  return (
    <span className={`inline-flex items-center gap-1.5 border px-2.5 py-1 font-body font-bold uppercase tracking-[0.18em] text-[10px] ${tone}`}>
      {(status === "SUBMITTED" || status === "UNDER_REVIEW") && (
        <span className="size-1.5 rounded-full bg-ember shadow-[0_0_8px_var(--vc-ember)] animate-[vc-pulse_1.4s_ease-in-out_infinite]" />
      )}
      {label}
    </span>
  );
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="vc-label">
      {label}
      {children}
      {error ? (
        <div className="vc-error" role="alert">
          {error}
        </div>
      ) : null}
    </label>
  );
}

export function inputClass(error?: string) {
  return error ? "vc-field vc-field-error" : "vc-field";
}

export function PageHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="mb-10 max-w-[760px]">
      <Eyebrow red>{eyebrow}</Eyebrow>
      <h1 className="vc-h1 mt-4 mb-4 text-bone">{title}</h1>
      {children}
    </header>
  );
}
