import { describe, expect, it, vi } from "vitest";
import { verifiedArtistDb } from "./test-helpers/verified-artist-db.js";
import { ArtistStudioService } from "./studio-service.js";

const owner = "0x1111111111111111111111111111111111111111";
const request = { requestId: "request-1", headers: {} };

function service(edition, { submittedMetadata = false, binding = null } = {}) {
  const repo = {
    saveEdition: vi.fn(async (input) => ({ id: input.id, release_id: input.releaseId, status: input.status })),
    saveToken: vi.fn(),
    appendAuditEvent: vi.fn(async () => ({})),
  };
  const db = { query: vi.fn(async (sql) => {
    const text = String(sql);
    if (text.includes("FROM editions e JOIN releases r")) return { rows: [{ owner_wallet: owner, artist_id: "artist-1", release_id: "release-1", contract_id: "contract-1", ...edition }] };
    if (text.includes("FROM tokens WHERE edition_id")) return { rows: submittedMetadata ? [{ "?column?": 1 }] : [] };
    if (text.includes("FROM release_contracts rc")) return { rows: binding ? [binding] : [] };
    return { rows: [] };
  }) };
  const instance = new ArtistStudioService({ db: verifiedArtistDb(db), repository: repo, authenticator: vi.fn().mockResolvedValue({ wallet: owner }), logger: { info: vi.fn(), error: vi.fn() } });
  return { instance, repo };
}

const stored = { id: "edition-1", title: "Chapter I", tier: "standard", description: "Liner notes", supply: "25", application_metadata: { includes: ["a"], artwork: "ipfs://art", priceWei: "1" } };
const update = (s, input) => s.instance.updateEdition({ request, editionId: "edition-1", input });

describe("published edition integrity", () => {
  for (const status of ["PUBLISHED", "ARCHIVED"]) {
    describe(`a ${status} edition`, () => {
      const fresh = () => service({ ...stored, status });
      it.each([
        ["title", { title: "Renamed" }],
        ["name", { name: "Renamed" }],
        ["tier", { tier: "vip" }],
        ["description", { description: "Rewritten" }],
        ["supply", { quantity: "1000" }],
        ["open supply", { quantity: "0" }],
        ["metadata", { metadata: { includes: ["b"], artwork: "ipfs://art", priceWei: "1" } }],
        ["metadata removed", { metadata: {} }],
      ])("refuses to change its %s", async (_label, input) => {
        const s = fresh();
        await expect(update(s, input)).rejects.toMatchObject({ status: 409, code: "PUBLISHED_EDITION_IMMUTABLE" });
        expect(s.repo.saveEdition).not.toHaveBeenCalled();
      });

      it("accepts a resave that changes nothing", async () => {
        const s = fresh();
        await update(s, { title: "Chapter I", tier: "standard", description: "Liner notes", quantity: "25", metadata: { artwork: "ipfs://art", priceWei: "1", includes: ["a"] } });
        expect(s.repo.saveEdition.mock.calls[0][0]).toMatchObject({ title: "Chapter I", supply: "25", status });
      });

      it("never moves back to DRAFT or REVIEW, and never to PUBLISHED without chain confirmation", async () => {
        for (const next of ["DRAFT", "REVIEW", "PUBLISHED"]) {
          const s = fresh();
          await expect(update(s, { status: next })).rejects.toMatchObject({ status: 409 });
          expect(s.repo.saveEdition).not.toHaveBeenCalled();
        }
      });
    });
  }

  it("still lets a published edition be taken off the site, unchanged otherwise", async () => {
    const s = service({ ...stored, status: "PUBLISHED" });
    await update(s, { status: "ARCHIVED" });
    expect(s.repo.saveEdition.mock.calls[0][0]).toMatchObject({ status: "ARCHIVED", title: "Chapter I", supply: "25", description: "Liner notes", tier: "standard" });
    expect(s.repo.saveEdition.mock.calls[0][0].metadata).toEqual(stored.application_metadata);
  });

  it("applies to a contract-bound published edition too", async () => {
    const binding = { release_contract_id: "contract-1", release_contract_address: "0x2222222222222222222222222222222222222222", chain_id: 43113, release_key: `0x${"1".repeat(64)}` };
    const s = service({ ...stored, status: "PUBLISHED" }, { binding });
    await expect(update(s, { quantity: "1000" })).rejects.toMatchObject({ code: "PUBLISHED_EDITION_IMMUTABLE" });
  });

  it("leaves draft editing unchanged, bound or not", async () => {
    const binding = { release_contract_id: "contract-1", release_contract_address: "0x2222222222222222222222222222222222222222", chain_id: 43113, release_key: `0x${"1".repeat(64)}` };
    for (const options of [{}, { binding }]) {
      const s = service({ ...stored, status: "DRAFT" }, options);
      await update(s, { title: "Renamed", quantity: "40", description: "New", tier: "vip", metadata: { includes: ["z"] } });
      expect(s.repo.saveEdition.mock.calls[0][0]).toMatchObject({ title: "Renamed", supply: "40", description: "New", tier: "vip", status: "DRAFT", metadata: { includes: ["z"] } });
    }
  });

  describe("a submitted but unconfirmed draft", () => {
    const submitted = (status = "DRAFT", options = {}) => service({ ...stored, status }, { submittedMetadata: true, ...options });
    const binding = { release_contract_id: "contract-1", release_contract_address: "0x2222222222222222222222222222222222222222", chain_id: 43113, release_key: `0x${"1".repeat(64)}` };

    it.each([["title", { title: "Renamed" }], ["name", { name: "Renamed" }], ["supply", { quantity: "40" }], ["open supply", { quantity: "0" }]])("refuses to change its %s, bound or not", async (_label, input) => {
      for (const options of [{}, { binding }]) {
        for (const status of ["DRAFT", "REVIEW"]) {
          const s = submitted(status, options);
          await expect(update(s, input)).rejects.toMatchObject({ status: 409, code: "EDITION_SUBMITTED_LOCKED" });
          expect(s.repo.saveEdition).not.toHaveBeenCalled();
        }
      }
    });

    it("accepts the Studio's retry resave: same title and supply, other fields as the form sends them", async () => {
      const s = submitted();
      await update(s, { title: "Chapter I", quantity: "25", description: "Liner notes", artwork: "ipfs://art", priceWei: "7", marketplace: {}, metadata: { includes: ["a"], artwork: "ipfs://art" } });
      expect(s.repo.saveEdition.mock.calls[0][0]).toMatchObject({ title: "Chapter I", supply: "25", status: "DRAFT" });
    });

    it("does not clear metadata_uri or touch tokens: only the edition row is saved", async () => {
      const s = submitted();
      await update(s, { description: "Typo fixed" });
      expect(s.repo.saveEdition).toHaveBeenCalledTimes(1);
      expect(s.repo.saveEdition.mock.calls[0][0]).toMatchObject({ title: "Chapter I", supply: "25", description: "Typo fixed" });
      expect(s.repo.saveToken).not.toHaveBeenCalled();
    });

    it("leaves a draft that was never submitted fully editable, so the guard cannot be what blocks it", async () => {
      const s = service({ ...stored, status: "DRAFT" }, { submittedMetadata: false });
      await update(s, { title: "Renamed", quantity: "40" });
      expect(s.repo.saveEdition.mock.calls[0][0]).toMatchObject({ title: "Renamed", supply: "40", status: "DRAFT" });
    });

    it("still refuses a title or supply change for a published edition with the published error", async () => {
      const s = submitted("PUBLISHED");
      await expect(update(s, { title: "Renamed" })).rejects.toMatchObject({ code: "PUBLISHED_EDITION_IMMUTABLE" });
    });
  });
});
