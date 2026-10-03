/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";

const studioFetch = vi.fn();
vi.mock("../lib/studio-api.js", async (importOriginal) => ({ ...(await importOriginal()), studioFetch: (...args) => studioFetch(...args) }));
const { ArtistProfileEditor } = await import("./ArtistProfileEditor.jsx");

const ownerRow = { id: "artist-a", display_name: "Voidcaller", bio: "Old bio", website_url: null, social_links: {}, profile_metadata: { profileArtwork: "ipfs://avatar", keep: true } };
const signedIn = { connected: true, authenticated: true, authHeaders: { authorization: "Bearer session" } };
const renderWith = (wallet, props = {}) => render(<WalletCtx.Provider value={wallet}><ArtistProfileEditor artistId="artist-a" {...props} /></WalletCtx.Provider>);

afterEach(() => { cleanup(); studioFetch.mockReset(); });

describe("artist profile editor", () => {
  it("is hidden from visitors who are not signed in", async () => {
    renderWith({ connected: false, authenticated: false, authHeaders: {} });
    await act(async () => {});
    expect(screen.queryByText("Edit profile")).toBeNull();
    expect(studioFetch).not.toHaveBeenCalled();
  });

  it("is hidden from a signed-in wallet that does not own this artist", async () => {
    studioFetch.mockResolvedValue({ artists: [{ id: "artist-other", display_name: "Someone" }] });
    renderWith(signedIn);
    await waitFor(() => expect(studioFetch).toHaveBeenCalledWith("/studio/catalog", expect.anything()));
    expect(screen.queryByText("Edit profile")).toBeNull();
  });

  it("lets the owner edit and save name, bio and links through the artist endpoint", async () => {
    const onSaved = vi.fn();
    studioFetch.mockImplementation(async (path) => (path === "/studio/catalog" ? { artists: [ownerRow] } : { id: "artist-a" }));
    renderWith(signedIn, { onSaved });
    fireEvent.click(await screen.findByText("Edit profile"));
    fireEvent.change(screen.getByLabelText("Bio"), { target: { value: "New bio" } });
    fireEvent.change(screen.getByLabelText("X"), { target: { value: "https://x.com/vc" } });
    fireEvent.click(screen.getByText("Save profile"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [path, options] = studioFetch.mock.calls.find(([call]) => call !== "/studio/catalog");
    expect(path).toBe("/studio/artists/artist-a");
    expect(options).toMatchObject({ method: "PATCH", payload: { name: "Voidcaller", bio: "New bio", links: { x: "https://x.com/vc" }, profileArtwork: "ipfs://avatar", profileMetadata: { keep: true } } });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ bio: "New bio", socials: [{ name: "X", href: "https://x.com/vc" }] }));
  });

  describe("standalone edit page mode", () => {
    it("tells a signed-out visitor to connect instead of rendering nothing", async () => {
      renderWith({ connected: false, authenticated: false, authHeaders: {} }, { standalone: true });
      await act(async () => {});
      expect(screen.getByText(/Connect and authenticate the wallet that owns this artist profile/)).toBeTruthy();
      expect(studioFetch).not.toHaveBeenCalled();
    });

    it("refuses a wallet that does not own the artist", async () => {
      studioFetch.mockResolvedValue({ artists: [{ id: "artist-other", display_name: "Someone" }] });
      renderWith(signedIn, { standalone: true });
      expect(await screen.findByText(/not owned by the connected wallet/)).toBeTruthy();
      expect(screen.queryByLabelText("Bio")).toBeNull();
    });

    it("opens the form directly for the owner and stays open after saving", async () => {
      studioFetch.mockImplementation(async (path) => (path === "/studio/catalog" ? { artists: [ownerRow] } : { id: "artist-a" }));
      renderWith(signedIn, { standalone: true });
      const bio = await screen.findByLabelText("Bio");
      expect(bio.value).toBe("Old bio");
      expect(screen.queryByText("Cancel")).toBeNull();
      fireEvent.change(bio, { target: { value: "Edited on the profile page" } });
      fireEvent.click(screen.getByText("Save profile"));
      expect(await screen.findByText("Profile saved.")).toBeTruthy();
      expect(screen.getByLabelText("Bio").value).toBe("Edited on the profile page");
      const [path, options] = studioFetch.mock.calls.find(([call]) => call !== "/studio/catalog");
      expect(path).toBe("/studio/artists/artist-a");
      expect(options).toMatchObject({ method: "PATCH", payload: { bio: "Edited on the profile page" } });
    });
  });
});
