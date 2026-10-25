import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(root, "public/site.webmanifest"), "utf8"));
const served = (href) => existsSync(resolve(root, "public", href.replace(/^\//, "")));

describe("app icons", () => {
  it("links the manifest once and every icon file it references exists", () => {
    expect(html.match(/rel="manifest"/g)).toHaveLength(1);
    expect(html).toContain('href="/site.webmanifest"');
    for (const icon of manifest.icons) expect(served(icon.src), icon.src).toBe(true);
  });

  it("references existing icon files from the document head with no duplicate apple-touch-icon", () => {
    const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png"]);
    for (const href of hrefs) expect(served(href), href).toBe(true);
    expect(html.match(/rel="apple-touch-icon"/g)).toHaveLength(1);
  });

  it("lists standard 192/512 icons and a separate maskable icon", () => {
    const by = (purpose) => manifest.icons.filter((i) => (i.purpose || "any") === purpose).map((i) => i.sizes);
    expect(by("any")).toEqual(["192x192", "512x512"]);
    expect(by("maskable")).toEqual(["512x512"]);
  });

  it("keeps the black Void theme color in the manifest and the head", () => {
    expect(manifest.theme_color).toBe("#000000");
    expect(html).toContain('<meta name="theme-color" content="#000000" />');
  });
});
