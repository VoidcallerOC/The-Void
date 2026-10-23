import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { ethers } from "ethers";
import { verifiedArtistDb } from "./test-helpers/verified-artist-db.js";

// Recorded test factories, as a manifest would list them: Factory V3 (version 3, V5 clones) and a
// future version 5 whose lifecycle interface has not been reviewed.
const { V3_FACTORY, FUTURE_FACTORY } = vi.hoisted(() => ({ V3_FACTORY: "0x00000000000000000000000000000000000000f3", FUTURE_FACTORY: "0x00000000000000000000000000000000000000f4" }));
vi.mock("../config/release-network.js", async (importOriginal) => {
  const original = await importOriginal();
  const extra = { [V3_FACTORY]: { releaseVersion: 3, albumCapable: true, chainId: 43113 }, [FUTURE_FACTORY]: { releaseVersion: 5, albumCapable: true, chainId: 43113 } };
  return { ...original, releaseDeploymentForFactory: (address) => { const entry = extra[String(address).toLowerCase()]; return entry ? { factoryAddress: String(address).toLowerCase(), ...entry } : original.releaseDeploymentForFactory(address); } };
});
import { ArtistStudioService } from "./studio-service.js";

const owner = "0x1111111111111111111111111111111111111111";
const request = { requestId: "request-1", headers: {} };

function repository() {
  const repo = {
    saveRelease: vi.fn(async (input) => ({ id: input.id, artist_id: input.artistId, status: input.status, release_metadata: input.metadata })),
    saveContract: vi.fn(async () => ({ id: "contract-uuid" })),
    saveEdition: vi.fn(async (input) => ({ id: input.id, release_id: input.releaseId, status: input.status })),
    saveToken: vi.fn(async (input) => input),
    appendAuditEvent: vi.fn(async () => ({})),
  };
  repo.inTransaction = vi.fn(async (callback) => callback(repo));
  return repo;
}

// route(sql, params) returns the rows for one query; anything unmatched gets no rows.
function service(route, { publicationChain = null } = {}) {
  const repo = repository();
  const db = { query: vi.fn(async (sql, params) => ({ rows: route(String(sql), params) || [] })) };
  const instance = new ArtistStudioService({ db: verifiedArtistDb(db), repository: repo, authenticator: vi.fn().mockResolvedValue({ wallet: owner }), publicationChain, logger: { info: vi.fn(), error: vi.fn() } });
  return { instance, repo, db };
}

const release = (id, releaseType, status = "DRAFT", artistId = "artist-1") => ({ id, artist_id: artistId, slug: id, title: id, description: null, status, release_metadata: releaseType === undefined ? {} : { releaseType }, published_at: null, owner_wallet: owner });

describe("release types", () => {
  it("creates SINGLE, EP and ALBUM releases and rejects anything else", async () => {
    for (const type of ["single", "EP", "Album"]) {
      const { instance, repo } = service((sql) => (sql.includes("FROM artists a") ? [{ id: "artist-1", slug: "a", display_name: "A", status: "ACTIVE", owner_wallet: owner }] : []));
      await instance.createRelease({ request, artistId: "artist-1", input: { title: `T ${type}`, releaseType: type } });
      expect(repo.saveRelease.mock.calls[0][0].metadata.releaseType).toBe(type.toUpperCase());
    }
    const { instance } = service((sql) => (sql.includes("FROM artists a") ? [{ id: "artist-1", slug: "a", display_name: "A", status: "ACTIVE", owner_wallet: owner }] : []));
    await expect(instance.createRelease({ request, artistId: "artist-1", input: { title: "Mixtape", releaseType: "MIXTAPE" } })).rejects.toMatchObject({ status: 400, code: "INVALID_RELEASE_TYPE" });
  });

  it("never edits an archived (retired) release, so a stale client cannot touch it", async () => {
    const { instance, repo } = service((sql) => (sql.includes("FROM releases r JOIN artist_owners") ? [release("release-retired", "SINGLE", "ARCHIVED")] : []));
    await expect(instance.updateRelease({ request, releaseId: "release-retired", input: { title: "Forgive & Forget", releaseType: "SINGLE" } })).rejects.toMatchObject({ status: 409, code: "RELEASE_ARCHIVED" });
    expect(repo.saveRelease).not.toHaveBeenCalled();
    expect(repo.appendAuditEvent).not.toHaveBeenCalled();
  });

  it("locks the release type once any edition is published, and allows the change before that", async () => {
    const locked = service((sql) => (sql.includes("FROM releases r JOIN artist_owners") ? [release("release-1", "EP", "PUBLISHED")] : sql.includes("status='PUBLISHED'") ? [{ "?column?": 1 }] : []));
    await expect(locked.instance.updateRelease({ request, releaseId: "release-1", input: { releaseType: "SINGLE" } })).rejects.toMatchObject({ status: 409, code: "RELEASE_TYPE_LOCKED" });
    // A legacy untyped release is EP; changing it after publication is a change too.
    const legacy = service((sql) => (sql.includes("FROM releases r JOIN artist_owners") ? [release("release-1", undefined, "PUBLISHED")] : sql.includes("status='PUBLISHED'") ? [{ "?column?": 1 }] : []));
    await expect(legacy.instance.updateRelease({ request, releaseId: "release-1", input: { releaseType: "ALBUM" } })).rejects.toMatchObject({ code: "RELEASE_TYPE_LOCKED" });
    await expect(legacy.instance.updateRelease({ request, releaseId: "release-1", input: { releaseType: "EP", title: "Renamed" } })).resolves.toBeTruthy();
    expect(locked.repo.saveRelease).not.toHaveBeenCalled();

    const draft = service((sql) => (sql.includes("FROM releases r JOIN artist_owners") ? [release("release-1", "EP")] : []));
    await draft.instance.updateRelease({ request, releaseId: "release-1", input: { releaseType: "SINGLE" } });
    expect(draft.repo.saveRelease.mock.calls[0][0].metadata.releaseType).toBe("SINGLE");
  });

  it("keeps the stored type when a client replaces release metadata wholesale", async () => {
    const { instance, repo } = service((sql) => (sql.includes("FROM releases r JOIN artist_owners") ? [release("release-1", "SINGLE")] : []));
    await instance.updateRelease({ request, releaseId: "release-1", input: { metadata: { note: "x" } } });
    expect(repo.saveRelease.mock.calls[0][0].metadata).toEqual({ note: "x", releaseType: "SINGLE" });
  });

  it("refuses a second edition on a published SINGLE but not on an EP", async () => {
    const single = service((sql) => (sql.includes("FROM releases r JOIN artist_owners") ? [release("single-1", "SINGLE", "PUBLISHED")] : sql.includes("status='PUBLISHED'") ? [{ "?column?": 1 }] : []));
    await expect(single.instance.createEdition({ request, releaseId: "single-1", input: { trackTitle: "B-side", quantity: "5" } })).rejects.toMatchObject({ status: 409, code: "SINGLE_ALREADY_PUBLISHED" });
    expect(single.repo.saveEdition).not.toHaveBeenCalled();

    const ep = service((sql) => (sql.includes("FROM releases r JOIN artist_owners") ? [release("ep-1", "EP", "PUBLISHED")] : sql.includes("status='PUBLISHED'") ? [{ "?column?": 1 }] : []));
    await expect(ep.instance.createEdition({ request, releaseId: "ep-1", input: { trackTitle: "Track 2", quantity: "5" } })).resolves.toMatchObject({ status: "DRAFT" });
  });

  it("refuses to publish metadata for a second edition of a published SINGLE before any storage write", async () => {
    const repo = repository();
    const metadataStorage = { write: vi.fn() };
    const db = { query: vi.fn(async (sql) => {
      const text = String(sql);
      if (text.includes("FROM releases r JOIN artists a")) return { rows: [{ ...release("single-1", "SINGLE", "PUBLISHED"), display_name: "A" }] };
      if (text.includes("e.status IN ('DRAFT','REVIEW')")) return { rows: [{ id: "edition-2", release_id: "single-1", title: "B-side", status: "DRAFT", application_metadata: {} }] };
      if (text.includes("status='PUBLISHED'")) return { rows: [{ "?column?": 1 }] };
      return { rows: [] };
    }) };
    const instance = new ArtistStudioService({ db: verifiedArtistDb(db), repository: repo, metadataStorage, authenticator: vi.fn().mockResolvedValue({ wallet: owner }), logger: { info: vi.fn(), error: vi.fn() } });
    await expect(instance.publishMetadata({ request, releaseId: "single-1", input: {} })).rejects.toMatchObject({ status: 409, code: "SINGLE_ALREADY_PUBLISHED" });
    expect(metadataStorage.write).not.toHaveBeenCalled();
  });

  it("lets an unpublished SINGLE create its edition", async () => {
    const { instance } = service((sql) => (sql.includes("FROM releases r JOIN artist_owners") ? [release("single-1", "SINGLE")] : []));
    await expect(instance.createEdition({ request, releaseId: "single-1", input: { trackTitle: "A-side", quantity: "5" } })).resolves.toMatchObject({ status: "DRAFT" });
  });
});

describe("standalone single on an album", () => {
  const album = release("album-1", "ALBUM");
  const single = release("single-1", "SINGLE", "PUBLISHED");
  function harness({ albumRow = album, singleRow = single, edition = { id: "edition-s1" }, insert } = {}) {
    return service((sql) => {
      if (sql.includes("FROM releases r JOIN artist_owners")) return albumRow ? [albumRow] : [];
      if (sql.includes("SELECT r.* FROM releases r WHERE r.id=$1")) return singleRow ? [singleRow] : [];
      if (sql.includes("FROM editions WHERE release_id=$1 AND status='PUBLISHED' ORDER BY")) return edition ? [edition] : [];
      if (sql.includes("INSERT INTO release_album_singles")) {
        if (insert) return insert();
        return [{ album_release_id: "album-1", single_release_id: "single-1", single_edition_id: "edition-s1", track_position: 3, created_at: "2026-10-10T00:00:00.000Z" }];
      }
      return [];
    });
  }

  it("records the link without touching the single's release, edition or token", async () => {
    const { instance, repo, db } = harness();
    await expect(instance.associateAlbumSingle({ request, albumReleaseId: "album-1", input: { singleReleaseId: "single-1", trackPosition: 3 } })).resolves.toEqual({ albumReleaseId: "album-1", singleReleaseId: "single-1", singleEditionId: "edition-s1", trackPosition: 3, createdAt: "2026-10-10T00:00:00.000Z" });
    const insert = db.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO release_album_singles"));
    expect(insert[1]).toEqual(["album-1", "single-1", "edition-s1", 3, owner]);
    expect(repo.saveRelease).not.toHaveBeenCalled();
    expect(repo.saveEdition).not.toHaveBeenCalled();
    expect(repo.saveToken).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(([sql]) => /UPDATE\s+(releases|editions|tokens|contracts)/i.test(String(sql)))).toBe(false);
    expect(repo.appendAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "STUDIO_ALBUM_SINGLE_ASSOCIATED", subjectId: "album-1" }));
  });

  it("requires an ALBUM on one side and a published SINGLE of the same artist on the other", async () => {
    const cases = [
      [{ albumRow: release("ep-1", "EP") }, 409, "ALBUM_RELEASE_REQUIRED"],
      [{ albumRow: release("album-1", "ALBUM", "ARCHIVED") }, 409, "ALBUM_RELEASE_ARCHIVED"],
      [{ albumRow: null }, 403, "ARTIST_ACCESS_DENIED"],
      [{ singleRow: release("single-1", "SINGLE", "PUBLISHED", "artist-2") }, 403, "ARTIST_ACCESS_DENIED"],
      [{ singleRow: null }, 403, "ARTIST_ACCESS_DENIED"],
      [{ singleRow: release("ep-2", "EP", "PUBLISHED") }, 409, "SINGLE_RELEASE_REQUIRED"],
      [{ singleRow: release("single-1", "SINGLE", "DRAFT") }, 409, "SINGLE_NOT_PUBLISHED"],
      [{ edition: null }, 409, "SINGLE_NOT_PUBLISHED"],
    ];
    for (const [options, status, code] of cases) {
      const { instance, db } = harness(options);
      await expect(instance.associateAlbumSingle({ request, albumReleaseId: "album-1", input: { singleReleaseId: "single-1", trackPosition: 1 } })).rejects.toMatchObject({ status, code });
      expect(db.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO release_album_singles"))).toBe(false);
    }
  });

  it("validates the track position and maps duplicates to clear conflicts", async () => {
    for (const trackPosition of [0, 1000, 1.5, "x", undefined]) {
      const { instance } = harness();
      await expect(instance.associateAlbumSingle({ request, albumReleaseId: "album-1", input: { singleReleaseId: "single-1", trackPosition } })).rejects.toMatchObject({ status: 400, code: "INVALID_TRACK_POSITION" });
    }
    const unique = (constraint) => () => { throw Object.assign(new Error("duplicate key"), { code: "23505", constraint }); };
    const taken = harness({ insert: unique("release_album_singles_album_release_id_track_position_key") });
    await expect(taken.instance.associateAlbumSingle({ request, albumReleaseId: "album-1", input: { singleReleaseId: "single-1", trackPosition: 2 } })).rejects.toMatchObject({ status: 409, code: "ALBUM_TRACK_POSITION_TAKEN" });
    const twice = harness({ insert: unique("release_album_singles_pkey") });
    await expect(twice.instance.associateAlbumSingle({ request, albumReleaseId: "album-1", input: { singleReleaseId: "single-1", trackPosition: 2 } })).rejects.toMatchObject({ status: 409, code: "ALBUM_SINGLE_ALREADY_ADDED" });
  });

  describe("D3: on-chain lifecycle guard for release type changes", () => {
    const clone = "0x4b2790791e2ac123cb012d33cc8f1ecbdc9b9bb0";
    const V4_FACTORY = "0x3e4E0d9187f6fD11bD6d792a7088D0c2dE8E3aC8"; // album-capable V2 factory (V4 clones)
    const v4Binding = { release_contract_id: "contract-1", release_contract_address: clone, chain_id: "43113", release_key: `0x${"ab".repeat(32)}`, implementation_version: 2, factory_address: V4_FACTORY };
    const v5Binding = { ...v4Binding, implementation_version: 3, factory_address: V3_FACTORY };
    const PRE_ALBUM_FACTORY = "0xa5CbA0F91cb0A81e0A9Ce89A6722Cbe4eeC93505"; // historical V2 factory, pre-album clones
    const lifecycle = new ethers.Interface(["function albumCreated() view returns (bool)", "function hasStandaloneEditions() view returns (bool)", "function maxSupplyOf(uint256) view returns (uint256)", "error EditionNotFound(uint256 tokenId)"]);
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const reverted = (data) => Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", data });
    // A fake Fuji clone. hasStandaloneEditions is V5-only: calling it on a V4 clone fails the test.
    function clonedChain({ albumCreated = false, standaloneFlag = null, minted = [], fail = false } = {}) {
      const request = vi.fn(async ({ params }) => {
        if (fail) throw Object.assign(new Error("connect ECONNREFUSED https://rpc.example/?key=secret"), { code: "SERVER_ERROR" });
        const data = params[0].data;
        if (data === lifecycle.encodeFunctionData("albumCreated")) return coder.encode(["bool"], [albumCreated]);
        if (data === lifecycle.encodeFunctionData("hasStandaloneEditions")) { if (standaloneFlag === null) throw new Error("hasStandaloneEditions() must not be called on a V4 clone"); return coder.encode(["bool"], [standaloneFlag]); }
        const [tokenId] = lifecycle.decodeFunctionData("maxSupplyOf", data);
        if (minted.includes(tokenId)) return coder.encode(["uint256"], [0]);
        throw reverted(lifecycle.encodeErrorResult("EditionNotFound", [tokenId]));
      });
      return { request };
    }
    const tokenFor = (slug) => BigInt(ethers.keccak256(coder.encode(["string", "bytes32"], ["the-void:release-edition:v1", ethers.encodeBytes32String(slug)])));
    // tokens: the token IDs stored for the release's editions (rows of the tokens table).
    const routed = (stored, { tokens = [], binding = v4Binding } = {}) => (sql) => (
      sql.includes("FROM releases r JOIN artist_owners") ? [release("release-1", stored)]
        : sql.includes("FROM release_contracts rc") ? (binding ? [binding] : [])
          : sql.includes("FROM tokens t JOIN editions e") ? tokens.map((tokenId) => ({ token_id: String(tokenId) }))
            : []);
    const toAlbum = { releaseType: "ALBUM" };

    it("refuses EP to ALBUM when an edition is mined on-chain but still DRAFT in the database", async () => {
      const mined = tokenFor("forgive-forget");
      const chain = clonedChain({ minted: [mined] });
      const { instance, repo } = service(routed("EP", { tokens: [mined] }), { publicationChain: chain });
      await expect(instance.updateRelease({ request, releaseId: "release-1", input: toAlbum })).rejects.toMatchObject({ status: 409, code: "STANDALONE_EDITIONS_EXIST" });
      expect(repo.saveRelease).not.toHaveBeenCalled();
    });

    it("finds the mined edition by its stored token ID after the draft edition was renamed", async () => {
      // Prepared and mined as "Forgive & Forget"; confirmation never completed; the draft was then renamed.
      // Only the tokens row still carries the mined ID; re-deriving it from the new title would miss it.
      const mined = tokenFor("forgive-forget");
      const chain = clonedChain({ minted: [mined] });
      const { instance, repo, db } = service((sql) => (sql.includes("SELECT id, title FROM editions") ? [{ id: "edition-1", title: "Renamed Draft" }] : routed("EP", { tokens: [mined] })(sql)), { publicationChain: chain });
      await expect(instance.updateRelease({ request, releaseId: "release-1", input: toAlbum })).rejects.toMatchObject({ code: "STANDALONE_EDITIONS_EXIST" });
      expect(repo.saveRelease).not.toHaveBeenCalled();
      expect(db.query.mock.calls.some(([sql]) => String(sql).includes("FROM tokens t JOIN editions e"))).toBe(true);
    });

    it("refuses ALBUM on a V5 clone whose guard flag is set even with no stored tokens", async () => {
      const { instance, repo } = service(routed("SINGLE", { binding: v5Binding }), { publicationChain: clonedChain({ standaloneFlag: true }) });
      await expect(instance.updateRelease({ request, releaseId: "release-1", input: toAlbum })).rejects.toMatchObject({ code: "STANDALONE_EDITIONS_EXIST" });
      expect(repo.saveRelease).not.toHaveBeenCalled();
    });

    it("allows EP to ALBUM on a V4 clone with no editions on-chain without calling the V5-only getter", async () => {
      const chain = clonedChain();
      const { instance, repo } = service(routed("EP", { tokens: [tokenFor("draft-only")] }), { publicationChain: chain });
      await instance.updateRelease({ request, releaseId: "release-1", input: toAlbum });
      expect(repo.saveRelease.mock.calls[0][0].metadata.releaseType).toBe("ALBUM");
      expect(chain.request.mock.calls.map(([payload]) => payload.params[0].data)).not.toContain(lifecycle.encodeFunctionData("hasStandaloneEditions"));
    });

    it("locks an album that is active on-chain against a change to SINGLE or EP", async () => {
      for (const target of ["SINGLE", "EP"]) {
        const { instance, repo } = service(routed("ALBUM"), { publicationChain: clonedChain({ albumCreated: true }) });
        await expect(instance.updateRelease({ request, releaseId: "release-1", input: { releaseType: target } })).rejects.toMatchObject({ status: 409, code: "ALBUM_TYPE_LOCKED" });
        expect(repo.saveRelease).not.toHaveBeenCalled();
      }
    });

    it("fails closed without echoing RPC details when the chain cannot be read", async () => {
      const { instance, repo } = service(routed("EP"), { publicationChain: clonedChain({ fail: true }) });
      const error = await instance.updateRelease({ request, releaseId: "release-1", input: toAlbum }).catch((caught) => caught);
      expect(error).toMatchObject({ status: 503, code: "RELEASE_CHAIN_STATE_UNAVAILABLE" });
      expect(error.message).not.toMatch(/secret|rpc\.example|ECONNREFUSED/);
      expect(repo.saveRelease).not.toHaveBeenCalled();
    });

    it("fails closed for a version 2 binding whose factory is not a recorded deployment", async () => {
      const chain = clonedChain();
      const { instance, repo } = service(routed("EP", { binding: { ...v4Binding, factory_address: "0x00000000000000000000000000000000000000aa" } }), { publicationChain: chain });
      await expect(instance.updateRelease({ request, releaseId: "release-1", input: toAlbum })).rejects.toMatchObject({ status: 503, code: "RELEASE_CHAIN_STATE_UNAVAILABLE" });
      expect(repo.saveRelease).not.toHaveBeenCalled();
      expect(chain.request).not.toHaveBeenCalled();
    });

    it("refuses a version 3 binding whose factory is not a recorded Factory V3, without reading the chain", async () => {
      for (const factory_address of ["0x00000000000000000000000000000000000000aa", V4_FACTORY]) {
        const chain = clonedChain({ standaloneFlag: false });
        const { instance, repo } = service(routed("EP", { binding: { ...v5Binding, factory_address } }), { publicationChain: chain });
        await expect(instance.updateRelease({ request, releaseId: "release-1", input: toAlbum })).rejects.toMatchObject({ status: 503, code: "RELEASE_CHAIN_STATE_UNAVAILABLE" });
        expect(repo.saveRelease).not.toHaveBeenCalled();
        expect(chain.request).not.toHaveBeenCalled();
      }
    });

    it("refuses a recorded factory with an unreviewed future version before any chain read or save", async () => {
      for (const [stored, target] of [["EP", "ALBUM"], ["ALBUM", "EP"], ["SINGLE", "EP"]]) {
        const chain = clonedChain({ albumCreated: true, standaloneFlag: true });
        const { instance, repo } = service(routed(stored, { binding: { ...v4Binding, implementation_version: 5, factory_address: FUTURE_FACTORY } }), { publicationChain: chain });
        await expect(instance.updateRelease({ request, releaseId: "release-1", input: { releaseType: target } })).rejects.toMatchObject({ status: 503, code: "RELEASE_CHAIN_STATE_UNAVAILABLE" });
        expect(repo.saveRelease).not.toHaveBeenCalled();
        expect(chain.request).not.toHaveBeenCalled();
      }
    });

    it("refuses a binding whose version does not match its recorded factory", async () => {
      for (const binding of [{ ...v4Binding, implementation_version: 3 }, { ...v5Binding, implementation_version: 2 }, { ...v4Binding, implementation_version: 4, factory_address: V3_FACTORY }]) {
        const chain = clonedChain();
        const { instance, repo } = service(routed("EP", { binding }), { publicationChain: chain });
        await expect(instance.updateRelease({ request, releaseId: "release-1", input: toAlbum })).rejects.toMatchObject({ status: 503, code: "RELEASE_CHAIN_STATE_UNAVAILABLE" });
        expect(repo.saveRelease).not.toHaveBeenCalled();
        expect(chain.request).not.toHaveBeenCalled();
      }
    });

    it("reads both lifecycle getters on the known V3/V5 implementation", async () => {
      const chain = clonedChain({ standaloneFlag: false });
      const { instance, repo } = service(routed("EP", { binding: v5Binding }), { publicationChain: chain });
      await instance.updateRelease({ request, releaseId: "release-1", input: toAlbum });
      expect(repo.saveRelease.mock.calls[0][0].metadata.releaseType).toBe("ALBUM");
      const calls = chain.request.mock.calls.map(([payload]) => payload.params[0].data);
      expect(calls).toEqual(expect.arrayContaining([lifecycle.encodeFunctionData("albumCreated"), lifecycle.encodeFunctionData("hasStandaloneEditions")]));
    });

    it("refuses ALBUM on a pre-album clone even with no editions, without reading the chain", async () => {
      const chain = clonedChain();
      const { instance, repo } = service(routed("EP", { binding: { ...v4Binding, factory_address: PRE_ALBUM_FACTORY } }), { publicationChain: chain });
      await expect(instance.updateRelease({ request, releaseId: "release-1", input: toAlbum })).rejects.toMatchObject({ status: 409, code: "ALBUM_NOT_SUPPORTED" });
      expect(repo.saveRelease).not.toHaveBeenCalled();
      expect(chain.request).not.toHaveBeenCalled();
    });

    it("still lets a pre-album clone change between SINGLE and EP", async () => {
      const chain = clonedChain();
      const { instance, repo } = service(routed("EP", { binding: { ...v4Binding, factory_address: PRE_ALBUM_FACTORY } }), { publicationChain: chain });
      await instance.updateRelease({ request, releaseId: "release-1", input: { releaseType: "SINGLE" } });
      expect(repo.saveRelease.mock.calls[0][0].metadata.releaseType).toBe("SINGLE");
    });

    it("does not read the chain when the type is unchanged or the release has no contract yet", async () => {
      const chain = clonedChain();
      const unchanged = service(routed("EP"), { publicationChain: chain });
      await unchanged.instance.updateRelease({ request, releaseId: "release-1", input: { releaseType: "EP", title: "Renamed" } });
      const unbound = service(routed("EP", { binding: null }), { publicationChain: chain });
      await unbound.instance.updateRelease({ request, releaseId: "release-1", input: toAlbum });
      expect(unbound.repo.saveRelease.mock.calls[0][0].metadata.releaseType).toBe("ALBUM");
      expect(chain.request).not.toHaveBeenCalled();
    });

    describe("through a real ethers JsonRpcProvider against a controlled JSON-RPC endpoint", () => {
      // ethers 6 turns every eth_call JSON-RPC error into CALL_EXCEPTION, with null revert data when the
      // node sent none (rate limits, missing state, internal errors). That must never read as "no getter".
      async function withRpc(errorFor, run) {
        const server = createServer((req, res) => {
          let body = "";
          req.on("data", (chunk) => { body += chunk; });
          req.on("end", () => {
            const payload = JSON.parse(body);
            const answer = (call) => {
              const error = errorFor(call);
              return error ? { jsonrpc: "2.0", id: call.id, error } : { jsonrpc: "2.0", id: call.id, result: coder.encode(["bool"], [false]) };
            };
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)));
          });
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${server.address().port}/`, 43113, { staticNetwork: true });
        try {
          return await run({ request: ({ method, params }) => provider.send(method, params) });
        } finally {
          provider.destroy();
          await new Promise((resolve) => server.close(resolve));
        }
      }

      it("confirms the ethers classification this guard must not trust", async () => {
        await withRpc(() => ({ code: -32000, message: "header not found" }), async ({ request: send }) => {
          const error = await send({ method: "eth_call", params: [{ to: clone, data: lifecycle.encodeFunctionData("albumCreated") }, "latest"] }).catch((caught) => caught);
          expect(error).toMatchObject({ code: "CALL_EXCEPTION", data: null });
        });
      });

      for (const [label, rpcError] of [["an RPC error with null revert data", { code: -32000, message: "header not found" }], ["a rate limit", { code: -32005, message: "rate limit exceeded" }]]) {
        it(`keeps an active album locked when albumCreated() hits ${label}`, async () => {
          await withRpc(() => rpcError, async (publicationChain) => {
            const { instance, repo } = service(routed("ALBUM"), { publicationChain });
            await expect(instance.updateRelease({ request, releaseId: "release-1", input: { releaseType: "EP" } })).rejects.toMatchObject({ status: 503, code: "RELEASE_CHAIN_STATE_UNAVAILABLE" });
            expect(repo.saveRelease).not.toHaveBeenCalled();
          });
        });
      }

      it("keeps an active album locked when the RPC endpoint is unreachable", async () => {
        // Take a free port, then close it so every request is refused.
        const closed = createServer();
        await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
        const { port } = closed.address();
        await new Promise((resolve) => closed.close(resolve));
        const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}/`, 43113, { staticNetwork: true });
        try {
          const { instance, repo } = service(routed("ALBUM"), { publicationChain: { request: ({ method, params }) => provider.send(method, params) } });
          await expect(instance.updateRelease({ request, releaseId: "release-1", input: { releaseType: "SINGLE" } })).rejects.toMatchObject({ status: 503, code: "RELEASE_CHAIN_STATE_UNAVAILABLE" });
          expect(repo.saveRelease).not.toHaveBeenCalled();
        } finally {
          provider.destroy();
        }
      });

      it("fails closed on a V5 binding when hasStandaloneEditions() cannot be read", async () => {
        const failing = (call) => (call.params?.[0]?.data === lifecycle.encodeFunctionData("hasStandaloneEditions") ? { code: -32005, message: "rate limit exceeded" } : null);
        await withRpc(failing, async (publicationChain) => {
          const { instance, repo } = service(routed("SINGLE", { binding: v5Binding }), { publicationChain });
          await expect(instance.updateRelease({ request, releaseId: "release-1", input: toAlbum })).rejects.toMatchObject({ status: 503, code: "RELEASE_CHAIN_STATE_UNAVAILABLE" });
          expect(repo.saveRelease).not.toHaveBeenCalled();
        });
      });
    });
  });
});

describe("D3: release-scoped lifecycle editions for Studio album activation", () => {
  const CLONE = "0x00000000000000000000000000000000000000c1";
  const ownedRelease = (sql) => sql.startsWith("SELECT r.id FROM releases r JOIN artist_owners");
  const tokenQuery = (sql) => sql.includes("SELECT DISTINCT t.token_id::text AS token_id FROM tokens t");
  const bindingQuery = (sql) => sql.includes("FROM release_contracts rc") && !sql.includes("LIMIT");

  it("returns every stored token ID and factory binding of the owner's release, uncapped and scoped to it", async () => {
    const binding = { release_id: "release-1", chain_id: 43113, release_contract_address: CLONE, factory_address: V3_FACTORY };
    const { instance, db } = service((sql, params) => (ownedRelease(sql) ? (params[0] === "release-1" && params[1] === owner ? [{ id: "release-1" }] : []) : tokenQuery(sql) ? [{ token_id: "5" }, { token_id: "7" }] : bindingQuery(sql) ? [binding] : []));
    await expect(instance.releaseLifecycleEditions({ request, releaseId: "release-1" })).resolves.toEqual({ releaseId: "release-1", complete: true, tokenIds: ["5", "7"], releaseBindings: [binding] });
    const scoped = db.query.mock.calls.filter(([sql]) => tokenQuery(String(sql)) || bindingQuery(String(sql)));
    expect(scoped).toHaveLength(2);
    for (const [sql, params] of scoped) {
      expect(params).toEqual(["release-1"]);
      expect(String(sql)).toContain(tokenQuery(String(sql)) ? "WHERE e.release_id=$1" : "WHERE rc.release_id=$1");
      expect(String(sql)).not.toMatch(/LIMIT/i);
    }
  });

  it("returns a complete empty result for an owned release with no stored editions", async () => {
    const { instance } = service((sql) => (ownedRelease(sql) ? [{ id: "release-1" }] : []));
    await expect(instance.releaseLifecycleEditions({ request, releaseId: "release-1" })).resolves.toEqual({ releaseId: "release-1", complete: true, tokenIds: [], releaseBindings: [] });
  });

  it("refuses another artist's or an unknown release before reading any edition", async () => {
    const { instance, db } = service(() => []);
    await expect(instance.releaseLifecycleEditions({ request, releaseId: "release-of-someone-else" })).rejects.toMatchObject({ status: 403, code: "ARTIST_ACCESS_DENIED" });
    expect(db.query.mock.calls.some(([sql]) => tokenQuery(String(sql)))).toBe(false);
    await expect(instance.releaseLifecycleEditions({ request, releaseId: "" })).rejects.toMatchObject({ name: "PersistenceValidationError" });
  });

  it("fails rather than answering when the edition query fails", async () => {
    const { instance } = service((sql) => {
      if (ownedRelease(sql)) return [{ id: "release-1" }];
      if (tokenQuery(sql)) throw new Error("connection terminated");
      return [];
    });
    await expect(instance.releaseLifecycleEditions({ request, releaseId: "release-1" })).rejects.toThrow("connection terminated");
  });
});
