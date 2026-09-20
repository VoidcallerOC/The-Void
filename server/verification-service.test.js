import { describe, expect, it, vi } from "vitest";
import { createArtistVerificationService } from "./verification-service.js";

const wallet = "0xd1b4367dd9f235f9ee61878019d66e31511e98ee";
const reviewer = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function validInput() {
  return {
    artistName: "Voidcaller",
    legalName: "Nicholas Sousa",
    email: "void@example.com",
    location: "Connecticut",
    artistType: "Musician",
    artistBio: "Metalcore from The Void.",
    workDescription: "On-chain records.",
    yearsActive: "10",
    verificationEvidence: "Official site plus wallet-controlled studio.",
    websiteUrl: "https://voidcaller.enterthegrotto.xyz",
  };
}

function requestFor(addr) {
  return { headers: { authorization: `Bearer ${addr}` }, requestId: "req-1" };
}

describe("artist verification service", () => {
  it("rejects unauthenticated submissions", async () => {
    const service = createArtistVerificationService({
      db: { query: vi.fn() },
      authenticator: async () => null,
    });
    await expect(service.submit({ request: requestFor(wallet), input: validInput() })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("persists a submitted application for the authenticated wallet", async () => {
    const query = vi.fn(async (sql, params) => {
      if (sql.includes("verification_rate_limits")) return { rows: [{ count: 1 }] };
      if (sql.includes("status = ANY") && sql.includes("wallet_address=$1")) return { rows: [] };
      if (sql.includes("artist_owners")) return { rows: [] };
      if (sql.startsWith("INSERT INTO artist_verification_applications")) {
        return {
          rows: [{
            id: params[0],
            public_id: params[1],
            wallet_address: params[2],
            artist_name: params[5],
            artist_type: params[9],
            location: params[8],
            artist_bio: params[19],
            slug: params[4],
            status: "SUBMITTED",
            email: params[7],
            submitted_at: params[26],
          }],
        };
      }
      if (sql.includes("verification_status_events")) return { rows: [] };
      return { rows: [] };
    });
    const service = createArtistVerificationService({
      db: { query },
      authenticator: async () => ({ wallet }),
    });
    const result = await service.submit({ request: requestFor(wallet), input: validInput() });
    expect(result.status).toBe("SUBMITTED");
    expect(result.artistName).toBe("Voidcaller");
    expect(result.legalName).toBeUndefined();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO artist_verification_applications"), expect.any(Array));
  });

  it("blocks a second live application from the same wallet", async () => {
    const service = createArtistVerificationService({
      db: {
        query: vi.fn(async (sql) => {
          if (sql.includes("verification_rate_limits")) return { rows: [{ count: 1 }] };
          if (sql.includes("status = ANY")) return { rows: [{ status: "SUBMITTED", wallet_address: wallet }] };
          return { rows: [] };
        }),
      },
      authenticator: async () => ({ wallet }),
    });
    await expect(service.submit({ request: requestFor(wallet), input: validInput() })).rejects.toMatchObject({ code: "APPLICATION_ALREADY_OPEN" });
  });

  it("keeps the review queue behind a reviewer wallet", async () => {
    const service = createArtistVerificationService({
      db: { query: vi.fn(async () => ({ rows: [] })) },
      authenticator: async () => ({ wallet }),
      reviewerWallets: reviewer,
    });
    await expect(service.listReviewQueue({ request: requestFor(wallet) })).rejects.toMatchObject({ code: "REVIEWER_REQUIRED" });
  });

  it("marks whether the authenticated wallet is a reviewer without leaking PII", async () => {
    const service = createArtistVerificationService({
      db: { query: vi.fn(async () => ({ rows: [] })) },
      authenticator: async () => ({ wallet }),
      reviewerWallets: reviewer,
    });
    const mine = await service.getMine({ request: requestFor(wallet) });
    expect(mine.reviewer).toBe(false);
    expect(mine.application).toBeNull();
    expect(mine.canReapply).toBe(true);
  });

  it("does not expose legal name on the public verified list", async () => {
    const service = createArtistVerificationService({
      db: {
        query: vi.fn(async () => ({
          rows: [{
            public_id: "va_1",
            artist_name: "Voidcaller",
            artist_type: "Musician",
            location: "CT",
            artist_bio: "Bio",
            slug: "voidcaller",
            status: "VERIFIED",
            legal_name: "secret",
            email: "secret@example.com",
            reviewed_at: "2026-09-19T00:00:00Z",
          }],
        })),
      },
      authenticator: async () => ({ wallet }),
    });
    const rows = await service.listVerified();
    expect(rows[0].verified).toBe(true);
    expect(rows[0].legalName).toBeUndefined();
    expect(rows[0].email).toBeUndefined();
  });
});
