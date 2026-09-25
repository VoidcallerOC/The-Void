import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ArtistRoutePage, ReleaseRoutePage } from "./App.jsx";
import { shell } from "./lib/marketplace-chrome.js";

// Regression: the Verify artist control used to render ABOVE the page shell,
// so the fixed 77px site <nav> covered all but a ~13px red strip of the
// 48px button and its label. It must render inside the shell, whose 104px
// top padding clears the fixed nav.
function render(path) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="artist/:artist" element={<ArtistRoutePage />} />
        <Route path="release/:release" element={<ReleaseRoutePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function expectButtonInsideShell(html) {
  expect(shell.padding.startsWith("104px")).toBe(true);
  const sectionOpen = html.indexOf("<section");
  const button = html.indexOf(">Verify artist</button>");
  expect(sectionOpen).toBeGreaterThanOrEqual(0);
  expect(button).toBeGreaterThan(sectionOpen);
  expect(html.slice(0, sectionOpen)).not.toContain("Verify artist");
  expect(html.slice(sectionOpen, html.indexOf(">", sectionOpen))).toContain("padding:104px");
}

describe("Verify artist control placement", () => {
  it("renders a labelled button inside the artist page shell (below the fixed nav)", () => {
    expectButtonInsideShell(render("/artist/voidcaller"));
  });

  it("renders a labelled button inside the release page shell (below the fixed nav)", () => {
    expectButtonInsideShell(render("/release/voidcaller-self-titled"));
  });

  it("does not render the control for other artists", () => {
    expect(render("/artist/someone-else")).not.toContain("Verify artist");
  });
});
