import { describe, expect, it, vi } from "vitest";
import { ApiService } from "./api-service.js";

const CID = "bafybeigdyrzt5sfp7hwz5secretcid123456789012345678901234";

function service(row) {
  const db = { query: vi.fn().mockResolvedValue({ rows: [row] }) };
  return { db, instance: new ApiService({ db, repository: {}, logger: { info() {}, error() {} } }) };
}

describe("public catalog reads", () => {
  it("projects the canonical Fuji token ID through the public edition response", async () => {
    const catalog = service({
      id: "edition-fuji",
      release_id: "release-fuji",
      title: "Fuji Edition",
      status: "PUBLISHED",
      chain_id: 43113,
      contract_address: "0x82b26da27136935454bdf1e40801190b521b82e5",
      token_id: "69621777096996404494569967715110965261109496187347335164928263396549073080909",
    });
    await expect(catalog.instance.getEdition({ id: "edition-fuji" })).resolves.toMatchObject({
      contract_address: "0x82b26da27136935454bdf1e40801190b521b82e5",
      chain_id: 43113,
      token_id: "69621777096996404494569967715110965261109496187347335164928263396549073080909",
    });
    const sql = String(catalog.db.query.mock.calls[0][0]);
    expect(sql).toContain("t.token_id::text AS token_id");
    expect(sql).toContain("lower(address)=$3 AND chain_id=$4");
  });

  it("does not return media_config, requirement internals, or storage keys", async () => {
    const poison = {
      id: "exp-1",
      artist_id: "artist-1",
      release_id: "rel-1",
      edition_id: "ed-1",
      slug: "session",
      title: "Session",
      description: "Listen",
      experience_type: "AUDIO",
      status: "PUBLISHED",
      supply: "10",
      media_config: { protected: true, protectedMedia: [{ storageKey: CID, mediaType: "AUDIO" }] },
      requirements: [{ type: "erc1155-balance", tokenIds: ["7"], contract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
      gated: true,
      protected: true,
      release_metadata: { artwork: "/assets/cover.png", storageKey: CID, nested: { cid: CID } },
      application_metadata: { artwork: "/assets/edition.png", storage_key: CID, includes: ["Audio"] },
      artist_slug: "voidcaller",
      artist_name: "Voidcaller",
      chain_id: 43113,
      contract_address: "0x262b774cf9a1949170b58e2d57f6189980fe757b",
    };
    const experiences = service(poison);
    const one = await experiences.instance.getExperience({ id: "exp-1" });
    const many = await experiences.instance.listExperiences({});
    const releases = service(poison);
    const release = await releases.instance.getRelease({ idOrSlug: "session" });
    const releaseList = await releases.instance.listReleases({});
    const editions = service(poison);
    const edition = await editions.instance.getEdition({ id: "ed-1" });
    const editionList = await editions.instance.listEditions({});
    for (const body of [one, many[0], release, releaseList[0], edition, editionList[0]]) {
      const encoded = JSON.stringify(body);
      expect(encoded).not.toMatch(/media_config/i);
      expect(encoded).not.toMatch(/storageKey|storage_key/i);
      expect(encoded).not.toContain(CID);
      expect(body.requirements).toBeUndefined();
      expect(body.media_config).toBeUndefined();
    }
    expect(release.release_metadata).toEqual({ artwork: "/assets/cover.png", nested: {} });
    expect(edition.application_metadata).toMatchObject({ artwork: "/assets/edition.png", includes: ["Audio"] });
    for (const db of [experiences.db, releases.db, editions.db]) {
      for (const [sql] of db.query.mock.calls) expect(String(sql)).not.toMatch(/select\s+\*/i);
    }
    expect(String(experiences.db.query.mock.calls[0][0])).toContain("id, artist_id");
    expect(String(experiences.db.query.mock.calls[0][0])).not.toMatch(/,\s*requirements\b/);
  });
});
