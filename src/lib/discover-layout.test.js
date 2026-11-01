
import { describe, it, expect } from "vitest";
import fs from "fs";

describe("Discover market grid layout", () => {
  it("uses auto-fill so a lone edition card stays card-sized instead of stretching across the page", () => {
    const css = fs.readFileSync("src/index.css", "utf8");
    expect(css).toMatch(/\.vc-market-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(300px,\s*100%\),\s*1fr\)\)/);
    expect(css).toMatch(/\.vc-market-grid\s*\{[^}]*width:\s*100%/);
  });
});

