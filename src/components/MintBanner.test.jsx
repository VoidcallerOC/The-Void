/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { MintBanner } from "./MintBanner.jsx";

afterEach(() => cleanup());

describe("site-wide mint banner", () => {
  it("names the release, price and time left, and links to its mint page", () => {
    const endTime = Math.floor(Date.now() / 1000) + 6.5 * 86400;
    render(<MemoryRouter><MintBanner featured={{ title: "Forgive & Forget", price: "0.25 AVAX", href: "/edition/ff", endTime }} /></MemoryRouter>);
    const banner = screen.getByTestId("mint-banner");
    expect(banner.getAttribute("href")).toBe("/edition/ff");
    expect(banner.textContent).toMatch(/Minting now.*Forgive & Forget.*0\.25 AVAX.*6 days left.*Mint →/);
  });
});
