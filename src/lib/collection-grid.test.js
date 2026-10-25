import { describe, expect, it } from "vitest";
import fs from "fs";

describe("Collection grid layout", () => {
  it("keeps collection cards at a capped size so they sit side by side instead of expanding", () => {
    const css = fs.readFileSync("src/index.css", "utf8");
    expect(css).toMatch(/\.vc-collection-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(260px,\s*320px\)\)/);
    expect(css).toMatch(/\.vc-collection-grid\s*\{[^}]*justify-content:\s*start/);
  });

  it("still collapses to a single column on narrow screens", () => {
    const css = fs.readFileSync("src/index.css", "utf8");
    expect(css).toMatch(/\.vc-market-grid,\s*\.vc-collection-grid,\s*\.vc-release-rail\s*\{[^}]*grid-template-columns:\s*1fr/);
  });

  it("does not change the Discover market grid", () => {
    const css = fs.readFileSync("src/index.css", "utf8");
    expect(css).toMatch(/\.vc-market-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(300px,\s*100%\),\s*1fr\)\)/);
  });
});
