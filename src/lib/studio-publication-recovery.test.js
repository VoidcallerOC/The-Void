import { describe, expect, it, vi } from "vitest";
import { reconcileExistingEdition } from "./studio-publication-recovery.js";

const mismatch = Object.assign(new Error("mismatch"), { code: "METADATA_URI_MISMATCH", details: { onChainMetadataUri: "ipfs://old", draftMetadataUri: "ipfs://new" } });

describe("reconciling an edition that already exists on-chain", () => {
  it("confirms without a transaction hash and without creating anything", async () => {
    const studioFetch = vi.fn().mockResolvedValue({ status: "PUBLISHED" });
    await expect(reconcileExistingEdition({ studioFetch, confirmPath: "/confirm", headers: {}, askToAdopt: vi.fn() })).resolves.toEqual({ status: "PUBLISHED" });
    expect(studioFetch).toHaveBeenCalledOnce();
    expect(studioFetch).toHaveBeenCalledWith("/confirm", { method: "POST", payload: {}, headers: {} });
  });

  it("adopts a different on-chain URI only after the artist accepts, showing both URIs", async () => {
    const studioFetch = vi.fn().mockRejectedValueOnce(mismatch).mockResolvedValueOnce({ status: "PUBLISHED" });
    const askToAdopt = vi.fn().mockResolvedValue(true);
    await reconcileExistingEdition({ studioFetch, confirmPath: "/confirm", headers: {}, askToAdopt });
    expect(askToAdopt).toHaveBeenCalledWith({ onChainMetadataUri: "ipfs://old", draftMetadataUri: "ipfs://new" });
    expect(studioFetch).toHaveBeenLastCalledWith("/confirm", { method: "POST", payload: { acceptOnChainMetadata: true }, headers: {} });
  });

  it("leaves everything unchanged when the artist declines", async () => {
    const studioFetch = vi.fn().mockRejectedValueOnce(mismatch);
    await expect(reconcileExistingEdition({ studioFetch, confirmPath: "/confirm", headers: {}, askToAdopt: vi.fn().mockResolvedValue(false) })).rejects.toMatchObject({ code: "ADOPTION_DECLINED" });
    expect(studioFetch).toHaveBeenCalledOnce();
  });

  it("passes other errors through", async () => {
    const studioFetch = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { code: "EDITION_CREATION_NOT_FOUND" }));
    await expect(reconcileExistingEdition({ studioFetch, confirmPath: "/c", headers: {}, askToAdopt: vi.fn() })).rejects.toMatchObject({ code: "EDITION_CREATION_NOT_FOUND" });
  });
});
