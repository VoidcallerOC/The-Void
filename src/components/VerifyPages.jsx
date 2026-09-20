import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Eyebrow, Tag } from "./Atoms.jsx";
import { WalletButton } from "./WalletButton.jsx";
import { useWallet } from "../lib/wallet-context.js";
import { ARTIST_TYPES, canApplicantReapply, canApplicantRespond, validateApplication } from "../lib/verification.js";
import {
  decideVerificationApplication,
  fetchMyApplication,
  fetchReviewApplication,
  fetchReviewQueue,
  respondToVerificationRequest,
  submitVerificationApplication,
} from "../lib/verification-api.js";
import { ghostBtn, primaryBtn, shell } from "../lib/marketplace-chrome.js";

const card = { border: "1px solid var(--vc-ash)", background: "var(--vc-abyss)", padding: 24 };
const field = { width: "100%", boxSizing: "border-box", marginTop: 7, padding: "12px 12px", minHeight: 44, color: "var(--vc-bone)", background: "var(--vc-pit)", border: "1px solid var(--vc-ash)", fontFamily: "var(--font-body)", fontSize: 16 };
const labelStyle = { display: "block", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--vc-bone-dim)", marginTop: 16 };
const muted = { color: "var(--vc-bone-dim)", lineHeight: 1.7, margin: 0 };

const STATUS_COPY = {
  SUBMITTED: "Your application is in the review queue. A human will read the evidence.",
  UNDER_REVIEW: "A reviewer is looking at the evidence for this identity.",
  NEEDS_INFORMATION: "The reviewer needs more from you before a decision.",
  VERIFIED: "This identity is verified. The mark is branded on-chain to the wallet that signed. It cannot be transferred, listed, or borrowed.",
  DECLINED: "This application was declined. You may submit a new one.",
  REVOKED: "Verification was revoked. You may submit a new application.",
};

const EMPTY_FORM = {
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

function Field({ title, error, children }) {
  return (
    <label style={labelStyle}>
      {title}
      {children}
      {error && <span role="alert" style={{ display: "block", marginTop: 6, color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".04em", textTransform: "none" }}>{error}</span>}
    </label>
  );
}

function inputStyle(error) {
  return { ...field, borderColor: error ? "var(--vc-crimson)" : "var(--vc-ash)" };
}

function StatusTag({ status }) {
  if (!status) return null;
  const kind = status === "VERIFIED" ? "crimson" : status === "DECLINED" || status === "REVOKED" ? "ash" : "outline";
  return <Tag kind={kind}>{status.replaceAll("_", " ")}</Tag>;
}

function PageHeader({ eyebrow, title, children }) {
  return (
    <header style={{ marginBottom: 40 }}>
      <Eyebrow red>{eyebrow}</Eyebrow>
      <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(48px, 9vw, 92px)", lineHeight: 0.92, textTransform: "uppercase", margin: "16px 0" }}>{title}</h1>
      {children}
    </header>
  );
}

function WalletGate({ message }) {
  const wallet = useWallet();
  return (
    <div style={{ ...card, marginBottom: 24, borderColor: "var(--vc-crimson)", display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
      <div>
        <strong>Wallet authentication required.</strong>
        <p style={{ margin: "8px 0 0", color: "var(--vc-bone-dim)" }}>{message}</p>
        {wallet.authenticationError && <p role="alert" style={{ margin: "8px 0 0", color: "var(--vc-crimson)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{wallet.authenticationError}</p>}
      </div>
      <WalletButton />
    </div>
  );
}

function Alert({ children }) {
  return <div role="alert" style={{ ...card, marginBottom: 24, borderColor: "var(--vc-crimson)", color: "var(--vc-crimson)" }}>{children}</div>;
}

export function VerifyLanding() {
  return (
    <section style={shell}>
      <PageHeader eyebrow="† Artist verification" title="Become verified">
        <p style={{ ...muted, maxWidth: 640 }}>Establish your identity. Authenticate your work. The mark is branded to the wallet that signs.</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 28 }}>
          <Link to="/verify/apply" style={primaryBtn}>Apply for verification</Link>
          <Link to="/verify/dashboard" style={ghostBtn}>View application status</Link>
        </div>
      </PageHeader>
      <div style={{ display: "grid", gap: 32, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <article>
          <Eyebrow red>What it is</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 36, textTransform: "uppercase", lineHeight: 1, margin: "12px 0 16px" }}>Control, not blessing</h2>
          <p style={muted}>Artist verification establishes that an artist identity is controlled by the person or team representing it. Verification does not constitute an endorsement of the artist, their work, or their commercial activity.</p>
        </article>
        <article>
          <Eyebrow>The chain</Eyebrow>
          <ol style={{ listStyle: "none", padding: 0, margin: "18px 0 0", display: "flex", flexDirection: "column", gap: 12, fontFamily: "var(--font-mono)", fontSize: 12, letterSpacing: ".12em", textTransform: "uppercase" }}>
            {["01  Connect a wallet", "02  Submit an application", "03  Human review", "04  Decision", "05  Mark branded to the wallet"].map((step) => (
              <li key={step} style={{ borderLeft: "1px solid var(--vc-ash)", paddingLeft: 16 }}>{step}</li>
            ))}
          </ol>
        </article>
        <article>
          <Eyebrow red>The mark</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 36, textTransform: "uppercase", lineHeight: 1, margin: "12px 0 16px" }}>Branded to the wallet</h2>
          <p style={muted}>The mark is branded on-chain to the wallet that signed. It is not a login, not a social, not a name anyone can type. Lose the key, lose the mark. It cannot be transferred, listed, or borrowed.</p>
        </article>
      </div>
      <div style={{ ...card, marginTop: 48 }}>
        <Eyebrow red>Do not overpromise</Eyebrow>
        <p style={{ ...muted, marginTop: 12, maxWidth: 720 }}>A verified mark means a reviewer accepted evidence that you control the named identity, and that identity is bound to the authenticated wallet. It is not a ranking, a booking, a distribution deal, or a guarantee of collection. It is not a token you can sell. False or unverifiable claims are declined.</p>
      </div>
    </section>
  );
}

export function VerifyApplyPage() {
  const wallet = useWallet();
  const navigate = useNavigate();
  const ready = wallet.connected && wallet.authenticated;
  const headers = useMemo(() => wallet.authHeaders, [wallet.authHeaders]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [blocked, setBlocked] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    fetchMyApplication({ headers })
      .then((result) => {
        if (cancelled) return;
        const current = result?.application;
        if (current && !canApplicantReapply(current.status)) {
          setBlocked(current.status === "VERIFIED" ? "This wallet already holds a verified artist identity." : "An application for this wallet is already in progress.");
        }
      })
      .catch((error) => {
        if (!cancelled) setFormError(error.message);
      });
    return () => { cancelled = true; };
  }, [ready, headers]);

  const set = (key, value) => setForm((prior) => ({ ...prior, [key]: value }));
  const setWork = (index, value) => setForm((prior) => {
    const next = [...(prior.workUrls || ["", "", ""])];
    next[index] = value;
    return { ...prior, workUrls: next };
  });

  const onSubmit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setErrors({});
    setFormError("");
    const payload = { ...form, workUrls: (form.workUrls || []).filter((url) => url.trim()) };
    const parsed = validateApplication(payload);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      setFormError("The application is incomplete or invalid.");
      setBusy(false);
      return;
    }
    try {
      const application = await submitVerificationApplication({ payload, headers });
      navigate(`/verify/received?id=${encodeURIComponent(application.publicId)}&name=${encodeURIComponent(application.artistName)}&status=${encodeURIComponent(application.status)}&submitted=${encodeURIComponent(application.submittedAt || "")}`);
    } catch (error) {
      setErrors(error.details || {});
      setFormError(error.message || "The application could not be stored.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={shell}>
      <PageHeader eyebrow="† Apply" title="Artist verification">
        <p style={{ ...muted, maxWidth: 640 }}>The application is stored against the authenticated wallet. Status is never taken from the browser.</p>
      </PageHeader>
      {!ready && <WalletGate message="Connect and authenticate a wallet before submitting an artist verification application." />}
      {formError && <Alert>{formError}</Alert>}
      {blocked && (
        <div style={{ ...card, marginBottom: 24 }}>
          <Eyebrow red>Already in progress</Eyebrow>
          <p style={{ ...muted, marginTop: 12 }}>{blocked}</p>
          <div style={{ marginTop: 18 }}>
            <Link to="/verify/dashboard" style={primaryBtn}>View application status</Link>
          </div>
        </div>
      )}
      {!blocked && (
        <form onSubmit={onSubmit} noValidate>
          <section style={card}>
            <Eyebrow red>01 · Identity</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 28, textTransform: "uppercase", margin: "10px 0 8px" }}>Artist identity</h2>
            <p style={muted}>The name collectors will see, and the person or team that controls it.</p>
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
              <Field title="Artist / stage name" error={errors.artistName}><input style={inputStyle(errors.artistName)} value={form.artistName} onChange={(e) => set("artistName", e.target.value)} autoComplete="nickname" required /></Field>
              <Field title="Legal name" error={errors.legalName}><input style={inputStyle(errors.legalName)} value={form.legalName} onChange={(e) => set("legalName", e.target.value)} autoComplete="name" required /></Field>
              <Field title="Email" error={errors.email}><input type="email" style={inputStyle(errors.email)} value={form.email} onChange={(e) => set("email", e.target.value)} autoComplete="email" required /></Field>
              <Field title="Location" error={errors.location}><input style={inputStyle(errors.location)} value={form.location} onChange={(e) => set("location", e.target.value)} autoComplete="country-name" required /></Field>
            </div>
            <Field title="Artist type" error={errors.artistType}>
              <select style={inputStyle(errors.artistType)} value={form.artistType} onChange={(e) => set("artistType", e.target.value)}>
                {ARTIST_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              </select>
            </Field>
          </section>
          <section style={{ ...card, marginTop: 24 }}>
            <Eyebrow red>02 · Presence</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 28, textTransform: "uppercase", margin: "10px 0 8px" }}>Where the work lives</h2>
            <p style={muted}>None of these are required. Add the channels you actually control.</p>
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
              {[["websiteUrl", "Official website"], ["instagramUrl", "Instagram"], ["tiktokUrl", "TikTok"], ["youtubeUrl", "YouTube"], ["spotifyUrl", "Spotify"], ["appleMusicUrl", "Apple Music"], ["soundcloudUrl", "SoundCloud"], ["bandcampUrl", "Bandcamp"], ["otherUrl", "Other URL"], ["portfolioUrl", "Portfolio"]].map(([key, title]) => (
                <Field key={key} title={title} error={errors[key]}><input style={inputStyle(errors[key])} value={form[key] || ""} onChange={(e) => set(key, e.target.value)} placeholder="https://" /></Field>
              ))}
            </div>
          </section>
          <section style={{ ...card, marginTop: 24 }}>
            <Eyebrow red>03 · Work</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 28, textTransform: "uppercase", margin: "10px 0 8px" }}>The work</h2>
            <Field title="Artist bio" error={errors.artistBio}><textarea style={{ ...inputStyle(errors.artistBio), minHeight: 110 }} value={form.artistBio} onChange={(e) => set("artistBio", e.target.value)} required /></Field>
            <Field title="Describe the work you make" error={errors.workDescription}><textarea style={{ ...inputStyle(errors.workDescription), minHeight: 110 }} value={form.workDescription} onChange={(e) => set("workDescription", e.target.value)} required /></Field>
            <Field title="Years active" error={errors.yearsActive}><input style={inputStyle(errors.yearsActive)} value={form.yearsActive} onChange={(e) => set("yearsActive", e.target.value)} required /></Field>
            {[0, 1, 2].map((index) => (
              <Field key={index} title={`Work URL ${index + 1}`} error={errors[`workUrls.${index}`]}>
                <input style={inputStyle(errors[`workUrls.${index}`])} value={form.workUrls[index] || ""} onChange={(e) => setWork(index, e.target.value)} placeholder="https://" />
              </Field>
            ))}
          </section>
          <section style={{ ...card, marginTop: 24 }}>
            <Eyebrow red>04 · Evidence</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 28, textTransform: "uppercase", margin: "10px 0 8px" }}>Control of this identity</h2>
            <p style={muted}>How can a reviewer confirm you control this artist name? Official site, socials, prior on-chain records, or studio ownership all count. Do not invent claims.</p>
            <Field title="Verification evidence" error={errors.verificationEvidence}><textarea style={{ ...inputStyle(errors.verificationEvidence), minHeight: 140 }} value={form.verificationEvidence} onChange={(e) => set("verificationEvidence", e.target.value)} required /></Field>
            <Field title="Additional information" error={errors.additionalInformation}><textarea style={{ ...inputStyle(errors.additionalInformation), minHeight: 90 }} value={form.additionalInformation} onChange={(e) => set("additionalInformation", e.target.value)} /></Field>
          </section>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 24 }}>
            <button type="submit" style={primaryBtn} disabled={busy || !ready}>{busy ? "Submitting…" : "Submit application"}</button>
            <Link to="/verify" style={ghostBtn}>Cancel</Link>
          </div>
        </form>
      )}
    </section>
  );
}

export function VerifyReceivedPage() {
  const [params] = useSearchParams();
  const id = params.get("id") || "";
  const name = params.get("name") || "Artist";
  const status = params.get("status") || "SUBMITTED";
  const submitted = params.get("submitted");
  const when = submitted ? new Date(submitted).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "just now";
  return (
    <section style={{ ...shell, maxWidth: 820 }}>
      <PageHeader eyebrow="† Received" title="Application received">
        <p style={muted}>Your Artist Verification application has been submitted.</p>
      </PageHeader>
      <div style={card}>
        <Eyebrow red>{name}</Eyebrow>
        <dl style={{ margin: "24px 0 0", display: "grid", gap: 16, fontFamily: "var(--font-mono)", fontSize: 12, letterSpacing: ".12em", textTransform: "uppercase" }}>
          <div>
            <dt style={{ color: "var(--vc-bone-dim)" }}>Application ID</dt>
            <dd style={{ margin: "6px 0 0" }}>{id || "—"}</dd>
          </div>
          <div>
            <dt style={{ color: "var(--vc-bone-dim)" }}>Status</dt>
            <dd style={{ margin: "8px 0 0" }}><StatusTag status={status} /></dd>
          </div>
          <div>
            <dt style={{ color: "var(--vc-bone-dim)" }}>Submitted</dt>
            <dd style={{ margin: "6px 0 0" }}>{when}</dd>
          </div>
        </dl>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 24 }}>
        <Link to="/verify/dashboard" style={primaryBtn}>View application status</Link>
        <Link to="/" style={ghostBtn}>Return to The Void</Link>
      </div>
    </section>
  );
}

export function VerifyDashboardPage() {
  const wallet = useWallet();
  const ready = wallet.connected && wallet.authenticated;
  const headers = useMemo(() => wallet.authHeaders, [wallet.authHeaders]);
  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [response, setResponse] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    fetchMyApplication({ headers })
      .then((result) => {
        if (cancelled) return;
        setState(result);
        setLoadError("");
        setLoaded(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(error.message);
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [ready, headers]);

  const application = state?.application;
  const onRespond = async () => {
    if (!application) return;
    setBusy(true);
    setNotice("");
    try {
      await respondToVerificationRequest({ publicId: application.publicId, payload: { applicantResponse: response }, headers });
      setResponse("");
      const result = await fetchMyApplication({ headers });
      setState(result);
      setLoadError("");
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={shell}>
      <PageHeader eyebrow="† Artist dashboard" title="Verification">
        <p style={muted}>Status is read from the stored application — never from the browser.</p>
      </PageHeader>
      {!ready && <WalletGate message="Connect and authenticate a wallet to see your verification status." />}
      {loadError && <Alert>{loadError}</Alert>}
      {notice && <Alert>{notice}</Alert>}
      {ready && loaded && !application && !loadError && (
        <div style={card}>
          <Eyebrow red>Not applied</Eyebrow>
          <p style={{ ...muted, marginTop: 12 }}>This wallet has not submitted an artist verification application.</p>
          <div style={{ marginTop: 18 }}><Link to="/verify/apply" style={primaryBtn}>Apply for verification</Link></div>
        </div>
      )}
      {application && (
        <div style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div>
              <Eyebrow red>{application.artistName}</Eyebrow>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 36, textTransform: "uppercase", margin: "10px 0 8px" }}>{application.artistName}</h2>
              <p style={{ ...muted, fontFamily: "var(--font-mono)", fontSize: 12, letterSpacing: ".12em", textTransform: "uppercase" }}>{application.publicId}</p>
            </div>
            <StatusTag status={application.status} />
          </div>
          <p style={{ ...muted, marginTop: 18 }}>{STATUS_COPY[application.status] || "Application recorded."}</p>
          {application.status === "VERIFIED" && (
            <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--vc-ash)" }}>
              <Eyebrow red>The mark</Eyebrow>
              <h3 style={{ fontFamily: "var(--font-display)", fontSize: 28, textTransform: "uppercase", margin: "10px 0 8px" }}>Branded to this wallet</h3>
              <p style={muted}>Collectors see the mark next to the identity that proved control. Move wallets and the mark does not follow. Steal the name and the chain still points at the address that earned it.</p>
              {wallet.account && (
                <p style={{ fontFamily: "var(--font-mono)", fontSize: 12, letterSpacing: ".08em", color: "var(--vc-bone)", margin: "14px 0 0", wordBreak: "break-all" }}>{wallet.account}</p>
              )}
            </div>
          )}
          {application.informationRequest && (
            <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--vc-ash)" }}>
              <Eyebrow>Information requested</Eyebrow>
              <p style={{ ...muted, marginTop: 10, whiteSpace: "pre-wrap" }}>{application.informationRequest}</p>
            </div>
          )}
          {application.decisionReason && application.status !== "NEEDS_INFORMATION" && (
            <p style={{ ...muted, marginTop: 16 }}>Reason · {application.decisionReason}</p>
          )}
          {canApplicantRespond(application.status) && (
            <div style={{ marginTop: 22 }}>
              <Field title="Response to reviewer">
                <textarea style={{ ...field, minHeight: 110 }} value={response} onChange={(e) => setResponse(e.target.value)} />
              </Field>
              <button type="button" style={{ ...primaryBtn, marginTop: 16 }} disabled={busy || !response.trim()} onClick={onRespond}>{busy ? "Sending…" : "Send response"}</button>
            </div>
          )}
          {canApplicantReapply(application.status) && (
            <div style={{ marginTop: 22 }}><Link to="/verify/apply" style={primaryBtn}>Submit a new application</Link></div>
          )}
        </div>
      )}
      {state?.reviewer && (
        <div style={{ marginTop: 24 }}>
          <Link to="/verify/review" style={ghostBtn}>Open review queue</Link>
        </div>
      )}
    </section>
  );
}

export function VerifyReviewQueuePage() {
  const wallet = useWallet();
  const ready = wallet.connected && wallet.authenticated;
  const headers = useMemo(() => wallet.authHeaders, [wallet.authHeaders]);
  const [apps, setApps] = useState([]);
  const [error, setError] = useState("");
  const [restricted, setRestricted] = useState(false);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    fetchReviewQueue({ headers })
      .then((rows) => {
        if (cancelled) return;
        setApps(Array.isArray(rows) ? rows : []);
        setRestricted(false);
        setError("");
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.status === 403 || err.code === "REVIEWER_REQUIRED") setRestricted(true);
        else setError(err.message);
      });
    return () => { cancelled = true; };
  }, [ready, headers]);

  return (
    <section style={shell}>
      <PageHeader eyebrow="† Review" title="Applications">
        <p style={muted}>Reviewer-only. Notes stay internal. Applicants never receive the private ledger.</p>
      </PageHeader>
      {!ready && <WalletGate message="Connect and authenticate a reviewer wallet to open this queue." />}
      {error && <Alert>{error}</Alert>}
      {restricted && (
        <div style={card}>
          <Eyebrow red>Restricted</Eyebrow>
          <p style={{ ...muted, marginTop: 12 }}>This wallet is not authorized to review artist verification applications. Reviewer wallets are configured server-side.</p>
        </div>
      )}
      {ready && !restricted && !error && apps.length === 0 && (
        <div style={card}>
          <Eyebrow>Queue</Eyebrow>
          <p style={{ ...muted, marginTop: 12 }}>No applications waiting for review.</p>
        </div>
      )}
      <div style={{ display: "grid", gap: 16 }}>
        {apps.map((app) => (
          <Link key={app.publicId} to={`/verify/review/${encodeURIComponent(app.publicId)}`} style={{ ...card, color: "inherit", textDecoration: "none", display: "block" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <Eyebrow red>{app.artistType} · {app.location}</Eyebrow>
              <StatusTag status={app.status} />
            </div>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 32, textTransform: "uppercase", margin: "10px 0 6px" }}>{app.artistName}</h2>
            <p style={{ ...muted, fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase" }}>{app.publicId}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}

const REVIEW_ACTIONS = [
  { status: "UNDER_REVIEW", label: "Begin review" },
  { status: "NEEDS_INFORMATION", label: "Request information" },
  { status: "VERIFIED", label: "Approve verification" },
  { status: "DECLINED", label: "Decline" },
  { status: "REVOKED", label: "Revoke" },
];

export function VerifyReviewApplicationPage() {
  const { id } = useParams();
  const wallet = useWallet();
  const ready = wallet.connected && wallet.authenticated;
  const headers = useMemo(() => wallet.authHeaders, [wallet.authHeaders]);
  const [app, setApp] = useState(null);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    if (!ready || !id) return;
    let cancelled = false;
    fetchReviewApplication({ publicId: id, headers })
      .then((result) => {
        if (cancelled) return;
        setApp(result);
        setNotes(result.reviewNotes || "");
        setError("");
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => { cancelled = true; };
  }, [ready, headers, id]);

  const decide = async (status) => {
    if (!app) return;
    setBusy(status);
    setError("");
    try {
      const result = await decideVerificationApplication({
        publicId: app.publicId,
        payload: { status, notes, reason },
        headers,
      });
      setApp(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
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
        ...(app.workUrls || []).map((url, index) => [`Work ${index + 1}`, url]),
      ].filter((entry) => entry[1])
    : [];

  return (
    <section style={shell}>
      <Link to="/verify/review" style={{ ...ghostBtn, minWidth: 0, marginBottom: 28 }}>← Queue</Link>
      <PageHeader eyebrow="† Reviewer" title={app?.artistName || "Application"}>
        {app && <StatusTag status={app.status} />}
      </PageHeader>
      {!ready && <WalletGate message="Connect and authenticate a reviewer wallet to open this application." />}
      {error && <Alert>{error}</Alert>}
      {app && (
        <div style={{ display: "grid", gap: 24, gridTemplateColumns: "minmax(0, 1.2fr) minmax(280px, 0.8fr)", alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <section style={card}>
              <Eyebrow red>Applicant</Eyebrow>
              <p style={{ margin: "14px 0 4px" }}>{app.legalName}</p>
              <p style={{ ...muted, fontFamily: "var(--font-mono)", fontSize: 12 }}>{app.email}</p>
              <p style={{ ...muted, fontFamily: "var(--font-mono)", fontSize: 12 }}>{app.artistType} · {app.location} · {app.yearsActive}</p>
              <p style={{ ...muted, marginTop: 16 }}>{app.artistBio}</p>
              <p style={{ ...muted, marginTop: 12 }}>{app.workDescription}</p>
            </section>
            <section style={card}>
              <Eyebrow red>Evidence</Eyebrow>
              <p style={{ marginTop: 16, whiteSpace: "pre-wrap", lineHeight: 1.7 }}>{app.verificationEvidence}</p>
              {app.additionalInformation && <p style={{ ...muted, whiteSpace: "pre-wrap", marginTop: 12 }}>{app.additionalInformation}</p>}
              {app.applicantResponse && (
                <>
                  <Eyebrow style={{ marginTop: 20 }}>Applicant response</Eyebrow>
                  <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.7 }}>{app.applicantResponse}</p>
                </>
              )}
              <ul style={{ listStyle: "none", padding: 0, margin: "18px 0 0", display: "flex", flexDirection: "column", gap: 8 }}>
                {links.map(([label, href]) => (
                  <li key={label}>
                    <a href={href} target="_blank" rel="noopener noreferrer" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--vc-crimson)" }}>{label} ↗</a>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <aside style={card}>
            <Eyebrow red>Decision</Eyebrow>
            <p style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--vc-bone-dim)", marginTop: 12 }}>{app.publicId}</p>
            <Field title="Internal review notes">
              <textarea style={{ ...field, minHeight: 110 }} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <Field title="Decision reason (visible to applicant)">
              <textarea style={{ ...field, minHeight: 90 }} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 22 }}>
              {REVIEW_ACTIONS.map((action) => (
                <button key={action.status} type="button" style={action.status === "VERIFIED" ? primaryBtn : ghostBtn} disabled={Boolean(busy)} onClick={() => decide(action.status)}>
                  {busy === action.status ? "Saving…" : action.label}
                </button>
              ))}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
