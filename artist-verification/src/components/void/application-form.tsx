import { useState, type FormEvent } from "react";
import { ARTIST_TYPES, type ApplicationInput, type FieldErrors } from "@/lib/verification/types";
import { Btn, Field, inputClass } from "./atoms";

const EMPTY: ApplicationInput = {
  artistName: "",
  legalName: "",
  email: "",
  location: "",
  artistType: "Musician",
  websiteUrl: "",
  instagramUrl: "",
  tiktokUrl: "",
  youtubeUrl: "",
  spotifyUrl: "",
  appleMusicUrl: "",
  soundcloudUrl: "",
  bandcampUrl: "",
  otherUrl: "",
  artistBio: "",
  workDescription: "",
  yearsActive: "",
  workUrls: ["", "", ""],
  portfolioUrl: "",
  verificationEvidence: "",
  additionalInformation: "",
};

export function ApplicationForm({
  defaultEmail,
  submitting,
  errors,
  formError,
  onSubmit,
}: {
  defaultEmail?: string | null;
  submitting: boolean;
  errors: FieldErrors;
  formError?: string | null;
  onSubmit: (value: ApplicationInput) => void;
}) {
  const [form, setForm] = useState<ApplicationInput>({
    ...EMPTY,
    email: defaultEmail ?? "",
    workUrls: ["", "", ""],
  });

  const set = (key: keyof ApplicationInput, value: string) => {
    setForm((prior) => ({ ...prior, [key]: value }));
  };

  const setWork = (index: number, value: string) => {
    setForm((prior) => {
      const next = [...(prior.workUrls ?? ["", "", ""])];
      next[index] = value;
      return { ...prior, workUrls: next };
    });
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      ...form,
      workUrls: (form.workUrls ?? []).filter((url) => url.trim()),
    });
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-8">
      {formError && (
        <div role="alert" className="vc-card border-crimson text-crimson">
          {formError}
        </div>
      )}

      <section className="vc-card">
        <p className="vc-card-kicker m-0 font-mono text-[11px] uppercase tracking-[0.16em] text-crimson">01 · Identity</p>
        <h2 className="mt-2 mb-1 font-display text-[28px] uppercase leading-none">Artist identity</h2>
        <p className="mt-2 mb-0 text-bone-dim">The name collectors will see, and the person or team that controls it.</p>
        <div className="vc-grid-2">
          <Field label="Artist / stage name" error={errors.artistName}>
            <input className={inputClass(errors.artistName)} value={form.artistName} onChange={(e) => set("artistName", e.target.value)} autoComplete="nickname" required />
          </Field>
          <Field label="Legal name" error={errors.legalName}>
            <input className={inputClass(errors.legalName)} value={form.legalName} onChange={(e) => set("legalName", e.target.value)} autoComplete="name" required />
          </Field>
          <Field label="Email" error={errors.email}>
            <input className={inputClass(errors.email)} type="email" value={form.email} onChange={(e) => set("email", e.target.value)} autoComplete="email" required />
          </Field>
          <Field label="Location" error={errors.location}>
            <input className={inputClass(errors.location)} value={form.location} onChange={(e) => set("location", e.target.value)} autoComplete="country-name" required />
          </Field>
        </div>
        <Field label="Artist type" error={errors.artistType}>
          <select className={inputClass(errors.artistType)} value={form.artistType} onChange={(e) => set("artistType", e.target.value)}>
            {ARTIST_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </Field>
      </section>

      <section className="vc-card">
        <p className="m-0 font-mono text-[11px] uppercase tracking-[0.16em] text-crimson">02 · Presence</p>
        <h2 className="mt-2 mb-1 font-display text-[28px] uppercase leading-none">Where the work lives</h2>
        <p className="mt-2 mb-0 text-bone-dim">None of these are required. Add the channels you actually control.</p>
        <div className="vc-grid-2">
          <Field label="Official website" error={errors.websiteUrl}>
            <input className={inputClass(errors.websiteUrl)} value={form.websiteUrl ?? ""} onChange={(e) => set("websiteUrl", e.target.value)} placeholder="https://" />
          </Field>
          <Field label="Instagram" error={errors.instagramUrl}>
            <input className={inputClass(errors.instagramUrl)} value={form.instagramUrl ?? ""} onChange={(e) => set("instagramUrl", e.target.value)} />
          </Field>
          <Field label="TikTok" error={errors.tiktokUrl}>
            <input className={inputClass(errors.tiktokUrl)} value={form.tiktokUrl ?? ""} onChange={(e) => set("tiktokUrl", e.target.value)} />
          </Field>
          <Field label="YouTube" error={errors.youtubeUrl}>
            <input className={inputClass(errors.youtubeUrl)} value={form.youtubeUrl ?? ""} onChange={(e) => set("youtubeUrl", e.target.value)} />
          </Field>
          <Field label="Spotify" error={errors.spotifyUrl}>
            <input className={inputClass(errors.spotifyUrl)} value={form.spotifyUrl ?? ""} onChange={(e) => set("spotifyUrl", e.target.value)} />
          </Field>
          <Field label="Apple Music" error={errors.appleMusicUrl}>
            <input className={inputClass(errors.appleMusicUrl)} value={form.appleMusicUrl ?? ""} onChange={(e) => set("appleMusicUrl", e.target.value)} />
          </Field>
          <Field label="SoundCloud" error={errors.soundcloudUrl}>
            <input className={inputClass(errors.soundcloudUrl)} value={form.soundcloudUrl ?? ""} onChange={(e) => set("soundcloudUrl", e.target.value)} />
          </Field>
          <Field label="Bandcamp" error={errors.bandcampUrl}>
            <input className={inputClass(errors.bandcampUrl)} value={form.bandcampUrl ?? ""} onChange={(e) => set("bandcampUrl", e.target.value)} />
          </Field>
        </div>
        <Field label="Other" error={errors.otherUrl}>
          <input className={inputClass(errors.otherUrl)} value={form.otherUrl ?? ""} onChange={(e) => set("otherUrl", e.target.value)} />
        </Field>
      </section>

      <section className="vc-card">
        <p className="m-0 font-mono text-[11px] uppercase tracking-[0.16em] text-crimson">03 · About</p>
        <h2 className="mt-2 mb-1 font-display text-[28px] uppercase leading-none">The work</h2>
        <Field label="Short artist bio" error={errors.artistBio}>
          <textarea className={inputClass(errors.artistBio)} rows={4} value={form.artistBio} onChange={(e) => set("artistBio", e.target.value)} required />
        </Field>
        <Field label="Description of work" error={errors.workDescription}>
          <textarea className={inputClass(errors.workDescription)} rows={5} value={form.workDescription} onChange={(e) => set("workDescription", e.target.value)} required />
        </Field>
        <Field label="Years active" error={errors.yearsActive}>
          <input className={inputClass(errors.yearsActive)} value={form.yearsActive} onChange={(e) => set("yearsActive", e.target.value)} placeholder="2016–present" required />
        </Field>
      </section>

      <section className="vc-card">
        <p className="m-0 font-mono text-[11px] uppercase tracking-[0.16em] text-crimson">04 · Portfolio</p>
        <h2 className="mt-2 mb-1 font-display text-[28px] uppercase leading-none">Representative work</h2>
        <p className="mt-2 mb-0 text-bone-dim">Up to three URLs. A portfolio link is optional.</p>
        <Field label="Work URL 1" error={errors.workUrls}>
          <input className={inputClass(errors.workUrls)} value={form.workUrls?.[0] ?? ""} onChange={(e) => setWork(0, e.target.value)} placeholder="https://" />
        </Field>
        <Field label="Work URL 2">
          <input className={inputClass()} value={form.workUrls?.[1] ?? ""} onChange={(e) => setWork(1, e.target.value)} />
        </Field>
        <Field label="Work URL 3">
          <input className={inputClass()} value={form.workUrls?.[2] ?? ""} onChange={(e) => setWork(2, e.target.value)} />
        </Field>
        <Field label="Portfolio URL" error={errors.portfolioUrl}>
          <input className={inputClass(errors.portfolioUrl)} value={form.portfolioUrl ?? ""} onChange={(e) => set("portfolioUrl", e.target.value)} />
        </Field>
      </section>

      <section className="vc-card">
        <p className="m-0 font-mono text-[11px] uppercase tracking-[0.16em] text-crimson">05 · Evidence</p>
        <h2 className="mt-2 mb-1 font-display text-[28px] uppercase leading-none">Prove control</h2>
        <p className="mt-2 mb-0 text-bone-dim">
          How can you demonstrate that you control this artist identity? Official site, socials, streaming profiles, label, management, or other supporting evidence.
        </p>
        <Field label="Verification evidence" error={errors.verificationEvidence}>
          <textarea
            className={inputClass(errors.verificationEvidence)}
            rows={5}
            value={form.verificationEvidence}
            onChange={(e) => set("verificationEvidence", e.target.value)}
            required
          />
        </Field>
        <Field label="Additional information (optional)">
          <textarea className={inputClass()} rows={3} value={form.additionalInformation ?? ""} onChange={(e) => set("additionalInformation", e.target.value)} />
        </Field>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Btn type="submit" disabled={submitting}>
          {submitting ? "Submitting…" : "Submit application"}
        </Btn>
        <p className="m-0 max-w-md text-[13px] text-bone-dim">
          Submitting stores this application against your signed-in account. You cannot set your own verification status.
        </p>
      </div>
    </form>
  );
}
