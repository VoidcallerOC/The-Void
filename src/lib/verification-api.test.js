import { describe, expect, it, vi } from "vitest";
import { fetchReviewCount } from "./verification-api.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("verification API client · reviewer count", () => {
  it("reads the count from the reviewer-only endpoint with the wallet session header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { count: 3 } }));
    await expect(fetchReviewCount({ headers: { authorization: "Bearer test" }, fetchImpl })).resolves.toEqual({ count: 3 });
    expect(fetchImpl).toHaveBeenCalledWith("/api/verification/review/count", expect.objectContaining({ method: "GET", headers: expect.objectContaining({ authorization: "Bearer test" }) }));
  });

  it("surfaces REVIEWER_REQUIRED with its status for unauthorized wallets", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { code: "REVIEWER_REQUIRED", message: "Not a reviewer." } }, 403));
    await expect(fetchReviewCount({ headers: { authorization: "Bearer test" }, fetchImpl })).rejects.toMatchObject({ code: "REVIEWER_REQUIRED", status: 403 });
  });
});
