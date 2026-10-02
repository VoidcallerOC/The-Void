import { describe, expect, it, vi } from "vitest";
import { ApiService } from "./api-service.js";

// Each track is its own token. The public edition response carries that
// token's published metadata (the public tokenURI document) so a track page
// can show its own name and artwork instead of the collection's.

const PRIVATE_CID = "bafybeigdyrzt5sfp7hwz5secretcidabcdefghijklmnopqrstuvwxyz";
const base = { id: "edition-1", release_id: "release-1", title: "Collection", status: "PUBLISHED", chain_id: 43113, contract_address: "0x82b26da27136935454bdf1e40801190b521b82e5", token_id: "7" };

function editionWith(row) {
  const db = { query: vi.fn().mockResolvedValue({ rows: [row] }) };
  return new ApiService({ db, repository: {}, logger: { info() {}, error() {} } }).getEdition({ id: "edition-1" });
}

describe("public token metadata on editions", () => {
  it("exposes the published token's name, artwork and preview", async () => {
    const edition = await editionWith({ ...base, token_metadata_uri: "ipfs://bafymetadatadocument", token_metadata: { name: "Complex", description: "Track three.", image: "ipfs://bafytrackartwork/3.png", animation_url: "ipfs://bafypublicpreview", attributes: [{ trait_type: "Track", value: "3" }], properties: { provenanceRoot: "0xabc" } } });
    expect(edition.token_metadata).toEqual({ name: "Complex", description: "Track three.", image: "ipfs://bafytrackartwork/3.png", animation_url: "ipfs://bafypublicpreview", attributes: [{ trait_type: "Track", value: "3" }] });
  });

  it("omits token metadata for unpublished tokens", async () => {
    const edition = await editionWith({ ...base, token_metadata_uri: null, token_metadata: { name: "Draft", image: "ipfs://bafydraftart" } });
    expect(edition.token_metadata).toBeUndefined();
  });

  it("still redacts CIDs anywhere except image and animation_url, and rejects odd URIs", async () => {
    const edition = await editionWith({ ...base, token_metadata_uri: "ipfs://bafymetadatadocument", token_metadata: { name: `Song ${PRIVATE_CID}`, description: PRIVATE_CID, image: "javascript:alert(1)", animation_url: "data:audio/wav;base64,AAAA", storageKey: PRIVATE_CID, attributes: [{ trait_type: "cid", value: PRIVATE_CID }] } });
    const encoded = JSON.stringify(edition);
    expect(encoded).not.toContain(PRIVATE_CID);
    expect(encoded).not.toContain("javascript:");
    expect(encoded).not.toContain("data:audio");
    expect(edition.token_metadata).toEqual({ name: "Song", attributes: [{ trait_type: "cid" }] });
  });
});
