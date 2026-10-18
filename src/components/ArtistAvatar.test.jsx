/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { ArtistAvatar, ArtistCard } from "./MarketplaceCards.jsx";
import { mapPublishedCatalog } from "../lib/catalog-source.js";

afterEach(cleanup);

const FILE = "artist-portfolio-0123456789abcdef.png";
const savedRow = { id: "artist-a", slug: "a", display_name: "Aria", profile_metadata: { profileArtwork: `/assets/artist-portfolio/${FILE}` } };

describe("artist avatar rendering", () => {
  it("shows the persisted profile picture on the public artist card after a reload (catalog -> card)", () => {
    const [artist] = mapPublishedCatalog({ artists: [savedRow] }).artists;
    render(<MemoryRouter><ArtistCard artist={artist} /></MemoryRouter>);
    expect(screen.getByTestId("artist-avatar").getAttribute("src")).toBe(`/api/artists/portfolio/${FILE}`);
  });

  it("shows a replaced picture, not the previous one", () => {
    const { rerender } = render(<ArtistAvatar artist={{ name: "Aria", avatar: "/api/artists/portfolio/artist-portfolio-aaaaaaaaaaaaaaaa.png" }} />);
    rerender(<ArtistAvatar artist={{ name: "Aria", avatar: `/api/artists/portfolio/${FILE}` }} />);
    expect(screen.getByTestId("artist-avatar").getAttribute("src")).toBe(`/api/artists/portfolio/${FILE}`);
  });

  it("falls back to the artist initial when there is no picture", () => {
    render(<ArtistAvatar artist={{ name: "Aria", avatar: "" }} />);
    expect(screen.getByTestId("artist-avatar-fallback").textContent).toBe("A");
  });

  it("falls back to the initial when the image URL does not load", () => {
    render(<ArtistAvatar artist={{ name: "Aria", avatar: "/api/artists/portfolio/artist-portfolio-ffffffffffffffff.png" }} />);
    fireEvent.error(screen.getByTestId("artist-avatar"));
    expect(screen.queryByTestId("artist-avatar")).toBeNull();
    expect(screen.getByTestId("artist-avatar-fallback")).toBeTruthy();
  });

  it("a removed picture maps back to the default avatar on reload", () => {
    const [artist] = mapPublishedCatalog({ artists: [{ ...savedRow, profile_metadata: { profileArtwork: null } }] }).artists;
    expect(artist.avatar).toBe("/assets/voidcaller_art_4.png");
  });
});
