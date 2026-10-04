import { describe, expect, it, vi } from "vitest";
import { ArtistStudioService } from "./studio-service.js";

const CONTRACT_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTRACT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
function service(rows) {
  return new ArtistStudioService({
    db: { query: vi.fn().mockResolvedValue({ rows }) },
    repository: { appendAuditEvent: vi.fn() },
    authenticator: vi.fn(),
    logger: { error: vi.fn() },
  });
}

const requirement = (contract, tokenId) => [{ type: "erc1155-balance", chainId: 43113, contract, tokenIds: [tokenId], minAmount: "1" }];

describe("release-bound protected media requirements", () => {
  it("accepts only the exact chain/contract/token tuple of the experience edition", async () => {
    const studio = service([{ chain_id: 43113, contract_address: CONTRACT_A, token_id: "7" }]);
    await expect(studio.assertEditionRequirements("edition-a", requirement(CONTRACT_A, "7"))).resolves.toBeUndefined();
  });

  it("rejects a different release contract even when the token ID is identical", async () => {
    const studio = service([{ chain_id: 43113, contract_address: CONTRACT_A, token_id: "7" }]);
    await expect(studio.assertEditionRequirements("edition-a", requirement(CONTRACT_B, "7"))).rejects.toMatchObject({ code: "REQUIREMENT_TOKEN_NOT_IN_EDITION" });
  });
});
