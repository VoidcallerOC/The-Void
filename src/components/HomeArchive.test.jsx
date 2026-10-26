// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { RELEASE_ARTWORK_FALLBACK } from "../lib/catalog-source.js";
import { releaseCoverSources } from "../lib/release-cover.js";
import { ReleaseCover } from "./HomeArchive.jsx";

const FF_TOKEN_IMAGE = "ipfs://bafybeidbhenxt5naxqq6mgev6spyixv5rzl2w5zivhvvv2xahjkudqqv4i";

describe("archive release covers", () => {
  it("uses the release's own stored artwork first", () => {
    const sources = releaseCoverSources({ release: { artwork: "/assets/voidcaller_ep_cover.webp" }, editions: [{ edition: { artwork: FF_TOKEN_IMAGE } }] });
    expect(sources[0]).toBe("/assets/voidcaller_ep_cover.webp");
  });

  it("uses the edition token image, not the generic site image, when the release stored none", () => {
    const sources = releaseCoverSources({ release: { artwork: RELEASE_ARTWORK_FALLBACK }, editions: [{ edition: { artwork: FF_TOKEN_IMAGE } }] });
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) expect(src).toContain("bafybeidbhenxt5naxqq6mgev6spyixv5rzl2w5zivhvvv2xahjkudqqv4i");
    expect(sources).not.toContain(RELEASE_ARTWORK_FALLBACK);
  });

  it("returns no sources when neither the release nor an edition has artwork", () => {
    expect(releaseCoverSources({ release: { artwork: RELEASE_ARTWORK_FALLBACK }, editions: [{ edition: {} }] })).toEqual([]);
  });

  it("shows a neutral plate when there is no artwork or every source fails", () => {
    const { container, rerender } = render(<ReleaseCover sources={[]} title="Untitled" />);
    expect(container.querySelector("[role='img']").getAttribute("aria-label")).toBe("Untitled: artwork unavailable");
    rerender(<ReleaseCover key="b" sources={["/missing.png"]} title="Broken" />);
    fireEvent.error(container.querySelector("img"));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[role='img']")).toBeTruthy();
  });
});
