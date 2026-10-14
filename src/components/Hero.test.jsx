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
    const matches = [...html.matchAll(/<h1\b[^>]*>/g)];
    expect(matches).toHaveLength(1);
    expect(html).toMatch(/<h1\b[^>]*>[\s\S]*alt="VOIDCALLER"/);
    expect(html).not.toMatch(/<h1\b[^>]*>[\s\S]*Four tracks/);
  });
});
