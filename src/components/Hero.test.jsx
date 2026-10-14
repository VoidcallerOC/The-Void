import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Hero } from "./Hero.jsx";

function renderHero() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Hero />
    </MemoryRouter>,
  );
}

describe("homepage Hero accessibility", () => {
  it("exposes a single meaningful document h1 for VOIDCALLER without extra visible heading text", () => {
    const html = renderHero();
    const open = html.indexOf("<h1");
    const close = html.indexOf("</h1>");
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(open);
    expect(html.indexOf("<h1", open + 1)).toBe(-1);
    const h1Block = html.slice(open, close);
    expect(h1Block).toContain('alt="VOIDCALLER"');
    expect(h1Block).not.toContain("Four tracks");
  });
});
