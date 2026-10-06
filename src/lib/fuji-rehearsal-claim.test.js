import { describe, expect, it } from "vitest";
import { FUJI_REHEARSAL_CLAIM_TARGET } from "./fuji-rehearsal-claim.js";

describe("Fuji rehearsal claim target", () => {
  it("keeps the temporary public surface bound to the supplied Release A tuple", () => {
    expect(FUJI_REHEARSAL_CLAIM_TARGET).toMatchObject({
      network: "Avalanche Fuji",
      chainId: 43113,
      releaseName: "Fuji Rehearsal Release A",
      releaseContract: "0x1AaF66f0aBA020321e63d684186886A3178A9BfC",
      primarySale: "0x1cBcde64E29473Ed4D40185c2e5a7745b338b996",
      provenanceAnchor: "0xD5F7c5e18941674104011A0AD50D292C2f108043",
      creationTransaction: "0x537e519fcbe7de9ccb44f64b2b05433b291a794d9e9b55b2e424113e4f7f2473",
    });
  });

  it("does not include an executable claim contract or signer", () => {
    expect(FUJI_REHEARSAL_CLAIM_TARGET).not.toHaveProperty("claimContract");
    expect(FUJI_REHEARSAL_CLAIM_TARGET).not.toHaveProperty("signer");
  });
});
