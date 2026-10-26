// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "@testing-library/react";
import { BrandLogo } from "./BrandLogo.jsx";

/* global process */
const root = process.cwd();
const publicFile = (urlPath) => resolve(root, "public", urlPath.replace(/^\//, ""));

describe("brand logo and head metadata", () => {
  it("renders the dark-site lockup with a compact wordmark source for the narrowest viewports", () => {
    const { container } = render(<BrandLogo />);
    const img = container.querySelector("img");
    expect(img.getAttribute("alt")).toBe("The Void");
    expect(img.getAttribute("src")).toBe("/brand/the-void/header-lockup-dark.svg");
    const source = container.querySelector("picture source");
    expect(source.getAttribute("srcset")).toBe("/brand/the-void/header-wordmark-dark.svg");
    expect(source.getAttribute("media")).toBe("(max-width: 300px)");
    expect(existsSync(publicFile(img.getAttribute("src")))).toBe(true);
    expect(existsSync(publicFile(source.getAttribute("srcset")))).toBe(true);
  });

  it("points every icon, manifest and social image reference at a file that ships", () => {
    const html = readFileSync(resolve(root, "index.html"), "utf8");
    const refs = [...html.matchAll(/(?:href|content)="((?:https:\/\/www\.thevoidstudio\.xyz)?\/[^"]+\.(?:ico|svg|png|webmanifest))"/g)]
      .map((m) => m[1].replace("https://www.thevoidstudio.xyz", ""));
    expect(refs.length).toBeGreaterThanOrEqual(6);
    for (const ref of refs) expect(existsSync(publicFile(ref)), ref).toBe(true);
    const manifest = JSON.parse(readFileSync(publicFile("/site.webmanifest"), "utf8"));
    for (const icon of manifest.icons) expect(existsSync(publicFile(icon.src)), icon.src).toBe(true);
  });
});
