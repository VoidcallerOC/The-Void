import { ghostBtn } from "../lib/marketplace-chrome.js";

// "Use a file already registered": attaches a file this artist already stored, so the upload is not
// repeated. Options are prepared by the page (already filtered by type and to unattached files). It
// only reports the choice; the server still checks ownership, type, visibility and edition scope.
export function RegisteredFilePicker({ label, options = [], onChoose, disabled = false, emptyHint = "" }) {
  if (!options.length) return emptyHint ? <p style={{ margin: "10px 0 0", color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{emptyHint}</p> : null;
  return (
    <label style={{ display: "block", marginTop: 10, color: "var(--vc-bone-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
      {label}
      <select
        aria-label={label}
        disabled={disabled}
        value=""
        style={{ ...ghostBtn, display: "block", marginTop: 6, maxWidth: "100%", padding: "10px 12px", cursor: disabled ? "not-allowed" : "pointer" }}
        onChange={(event) => { const value = event.target.value; if (value) onChoose(options.find((option) => option.value === value)); }}
      >
        <option value="">Choose…</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}
