/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletCtx } from "../lib/wallet-context.js";

const requestProtectedMediaGrant = vi.fn();
vi.mock("../lib/media-auth.js", async (importOriginal) => ({ ...(await importOriginal()), requestProtectedMediaGrant: (...args) => requestProtectedMediaGrant(...args) }));
const { ProtectedExperiencePlayer } = await import("./ProtectedExperiencePlayer.jsx");

const experience = { id: "experience-1" };
const holder = { connected: true, authenticated: true, account: "0xabc", authHeaders: { authorization: "Bearer s" } };
const renderWith = (wallet) => render(<WalletCtx.Provider value={wallet}><ProtectedExperiencePlayer experience={experience} /></WalletCtx.Provider>);

afterEach(() => { cleanup(); requestProtectedMediaGrant.mockReset(); });

describe("protected experience player", () => {
  it("asks a visitor without a wallet to connect and requests nothing", () => {
    renderWith({ connected: false });
    expect(screen.getByText(/Connect the wallet that holds this edition/)).toBeTruthy();
    expect(requestProtectedMediaGrant).not.toHaveBeenCalled();
  });

  it("streams the grant the gateway issues to a holder", async () => {
    requestProtectedMediaGrant.mockResolvedValue({ grantId: "g1", accessUrl: "https://api.example/api/media/g1" });
    const { container } = renderWith(holder);
    fireEvent.click(screen.getByText("Unlock & play"));
    await waitFor(() => expect(container.querySelector("audio")?.getAttribute("src")).toBe("https://api.example/api/media/g1"));
    expect(requestProtectedMediaGrant).toHaveBeenCalledWith(expect.objectContaining({ wallet: "0xabc", experienceId: "experience-1", mediaType: "AUDIO" }));
  });

  it("shows the gateway's refusal to a non-holder and plays nothing", async () => {
    requestProtectedMediaGrant.mockRejectedValue(new Error("This wallet does not hold the required edition."));
    const { container } = renderWith(holder);
    fireEvent.click(screen.getByText("Unlock & play"));
    await waitFor(() => expect(screen.getByText("This wallet does not hold the required edition.")).toBeTruthy());
    expect(container.querySelector("audio")).toBeNull();
  });
});
