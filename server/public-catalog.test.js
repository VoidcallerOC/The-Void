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
      release_contract_address: "0x82b26da27136935454bdf1e40801190b521b82e5",
      factory_address: "0x8291A4F1936C1c5C6D8917b0966c80757cd5c265",
      primary_sale_address: "0x1111111111111111111111111111111111111111",
      token_id: "69621777096996404494569967715110965261109496187347335164928263396549073080909",
    });
    await expect(catalog.instance.getEdition({ id: "edition-fuji" })).resolves.toMatchObject({
      contract_address: "0x82b26da27136935454bdf1e40801190b521b82e5",
      release_contract_address: "0x82b26da27136935454bdf1e40801190b521b82e5",
      factory_address: "0x8291A4F1936C1c5C6D8917b0966c80757cd5c265",
      chain_id: 43113,
      primary_sale_address: "0x1111111111111111111111111111111111111111",
      token_id: "69621777096996404494569967715110965261109496187347335164928263396549073080909",
    });
    const sql = String(catalog.db.query.mock.calls[0][0]);
    expect(sql).toContain("t.token_id::text AS token_id");
    expect(sql).toContain("lower(address)=$3 AND chain_id=$4");
    expect(sql).toContain("sale.address AS primary_sale_address");
    expect(sql).toContain("factory.address AS factory_address");
  });

  it("exposes chain-indexed album single and mint deadline only on album track editions", async () => {
    const base = { id: "edition-track", release_id: "release-album", title: "Track", status: "PUBLISHED", chain_id: "43113", contract_address: "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1", token_id: "5" };
    const single = service({ ...base, album_is_single: true, album_mint_end: "1900000000", album_closed: false });
    const edition = await single.instance.getEdition({ id: "edition-track" });
    expect(edition).toMatchObject({ id: "edition-track", token_id: "5", isAlbumSingle: true, mintEnd: "1900000000", albumClosed: false });
    expect(edition).not.toHaveProperty("album_is_single");
    const sql = String(single.db.query.mock.calls[0][0]);
    expect(sql).toContain("LEFT JOIN release_album_tracks album_track ON album_track.chain_id=c.chain_id AND album_track.contract_address=lower(c.address) AND album_track.token_id=t.token_id");
    expect(sql).toContain("LEFT JOIN release_albums album ON album.chain_id=c.chain_id");

    const track = service({ ...base, album_is_single: false, album_mint_end: "0", album_closed: true });
    await expect(track.instance.listEditions({})).resolves.toEqual([expect.objectContaining({ isAlbumSingle: false, mintEnd: "0", albumClosed: true })]);
    expect(String(track.db.query.mock.calls[0][0])).toContain("LEFT JOIN release_album_tracks album_track");

    // A LEFT JOIN miss leaves the non-album edition response exactly as before.
    const plain = service({ ...base, album_is_single: null, album_mint_end: null, album_closed: false });
    const plainEdition = await plain.instance.getEdition({ id: "edition-track" });
    expect(plainEdition).toEqual({ id: "edition-track", release_id: "release-album", title: "Track", status: "PUBLISHED", chain_id: "43113", contract_address: "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1", token_id: "5" });
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

  it("omits the withdrawn Fuji Forgive & Forget release from public collect reads", async () => {
    const releaseId = "release-1b4a2d71-218f-47a2-afde-cd5171909ace";
    const editionId = "edition-9362e29d-341d-4e84-a64b-45753e7d0ff1";
    const experienceId = "experience-d798300c-37eb-4cc6-aad3-4b078b77135a";
    const forgiveRelease = { id: releaseId, artist_id: "voidcaller", slug: "forgive-forget-23", title: "Forgive & Forget", status: "PUBLISHED", artist_slug: "voidcaller", artist_name: "Voidcaller" };
    const legacyRelease = { id: "voidcaller-legacy-genesis", artist_id: "voidcaller", slug: "voidcaller-legacy-genesis", title: "VOIDCALLER", status: "PUBLISHED", artist_slug: "voidcaller", artist_name: "Voidcaller" };
    const forgiveEdition = { id: editionId, release_id: releaseId, title: "Forgive & Forget", status: "PUBLISHED", chain_id: 43113, contract_address: "0x7bba0690a43e2ffe9ad553fbda0451177b7b95b6", token_id: "1" };
    const legacyEdition = { id: "voidcaller-legacy-edition", release_id: "voidcaller-legacy-genesis", title: "Chapter I · The Relic", status: "PUBLISHED", chain_id: 43114, contract_address: "0xd1b4367dd9f235f9ee61878019d66e31511e98ee" };
    const forgiveExperience = { id: experienceId, artist_id: "voidcaller", release_id: releaseId, edition_id: editionId, title: "Stranger Things", status: "PUBLISHED", experience_type: "DEMO" };

    const releases = service(forgiveRelease);
    releases.db.query.mockResolvedValue({ rows: [forgiveRelease, legacyRelease] });
    await expect(releases.instance.getRelease({ idOrSlug: "forgive-forget-23" })).rejects.toMatchObject({ code: "RELEASE_NOT_FOUND", status: 404 });
    await expect(releases.instance.listReleases({})).resolves.toEqual([expect.objectContaining({ id: "voidcaller-legacy-genesis", title: "VOIDCALLER" })]);

    const editions = service(forgiveEdition);
    editions.db.query.mockResolvedValue({ rows: [forgiveEdition, legacyEdition] });
    await expect(editions.instance.getEdition({ id: editionId })).rejects.toMatchObject({ code: "EDITION_NOT_FOUND", status: 404 });
    await expect(editions.instance.listEditions({})).resolves.toEqual([expect.objectContaining({ id: "voidcaller-legacy-edition", title: "Chapter I · The Relic" })]);

    const experiences = service(forgiveExperience);
    await expect(experiences.instance.getExperience({ id: experienceId })).rejects.toMatchObject({ code: "EXPERIENCE_NOT_FOUND", status: 404 });
    await expect(experiences.instance.listExperiences({})).resolves.toEqual([]);
  });
});
