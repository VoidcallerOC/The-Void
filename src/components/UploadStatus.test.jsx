import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArtworkField, UploadStatus } from "./ArtistStudioPage.jsx";

describe("upload status next to each upload button", () => {
  it("tells a signed-out artist why the upload button does nothing", () => {
    expect(renderToStaticMarkup(<UploadStatus signedIn={false} />)).toContain("Sign in with your artist wallet to upload.");
  });

  it("explains that track artwork is optional", () => {
    const copy = "Leave this empty and the track uses the release artwork; only upload here if this track needs a different image.";
    const markup = renderToStaticMarkup(<ArtworkField title="Track artwork (optional)" helper={copy} value="" onChange={() => {}} onUpload={() => {}} uploading={false} disabled={false} signedIn />);
    expect(markup).toContain(copy);
    expect(markup).not.toContain("ipfs://");
  });

  it("shows progress, a confirmed result, and errors", () => {
    expect(renderToStaticMarkup(<UploadStatus status={{ state: "uploading", message: "Uploading song.mp3 (4.2 MB)…" }} />)).toContain("Uploading song.mp3 (4.2 MB)…");
    const done = renderToStaticMarkup(<UploadStatus status={{ state: "done", message: "Public preview uploaded: clip.mp3 (512 KB) · ipfs://bafy" }} />);
    expect(done).toContain("✓ Public preview uploaded: clip.mp3 (512 KB) · ipfs://bafy");
    expect(done).toContain('role="status"');
    expect(renderToStaticMarkup(<UploadStatus status={{ state: "error", message: "song.mp3: Audio must be 15 MB or smaller." }} />)).toContain("✕ song.mp3: Audio must be 15 MB or smaller.");
    expect(renderToStaticMarkup(<UploadStatus />)).toBe("");
  });
});
