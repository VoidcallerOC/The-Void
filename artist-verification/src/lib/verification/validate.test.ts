import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllowedHttpUrl, makePublicId, slugify, validateApplication } from "./validate.ts";
import type { ApplicationInput } from "./types.ts";

function valid(overrides: Partial<ApplicationInput> = {}): ApplicationInput {
  return {
    artistName: "Voidcaller",
    legalName: "Nicholas Sousa",
    email: "void@enterthegrotto.xyz",
    location: "Connecticut, US",
    artistType: "Musician",
    websiteUrl: "https://voidcaller.enterthegrotto.xyz",
    artistBio: "On-chain metalcore from the pit.",
    workDescription: "Limited relics, EPs, and ritual live sessions.",
    yearsActive: "2016–present",
    verificationEvidence: "Official site and streaming profiles are controlled by this identity.",
    workUrls: ["https://open.spotify.com/artist/example"],
    ...overrides,
  };
}

describe("application validation", () => {
  it("accepts a complete valid application", () => {
    const result = validateApplication(valid());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.artistName, "Voidcaller");
      assert.equal(result.value.artistType, "Musician");
      assert.equal(result.value.workUrls.length, 1);
    }
  });

  it("requires artist name, email, and evidence", () => {
    const result = validateApplication(
      valid({ artistName: " ", email: "nope", verificationEvidence: "" }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errors.artistName, "Enter your artist/stage name.");
      assert.equal(result.errors.email, "Enter a valid email address.");
      assert.match(result.errors.verificationEvidence, /verify control/i);
    }
  });

  it("rejects invalid URLs and javascript schemes", () => {
    const result = validateApplication(
      valid({ websiteUrl: "javascript:alert(1)", instagramUrl: "not a url" }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errors.websiteUrl, "Please enter a valid URL.");
      assert.equal(result.errors.instagramUrl, "Please enter a valid URL.");
    }
  });

  it("rejects private and localhost URLs", () => {
    assert.equal(isAllowedHttpUrl("https://127.0.0.1/secret"), false);
    assert.equal(isAllowedHttpUrl("http://localhost/x"), false);
    assert.equal(isAllowedHttpUrl("https://192.168.0.12/x"), false);
    assert.equal(isAllowedHttpUrl("https://open.spotify.com/artist/x"), true);
  });

  it("normalizes protocol-less URLs", () => {
    const result = validateApplication(valid({ websiteUrl: "voidcaller.enterthegrotto.xyz" }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.websiteUrl, "https://voidcaller.enterthegrotto.xyz");
  });

  it("limits work URLs to three", () => {
    const result = validateApplication(
      valid({
        workUrls: [
          "https://a.example.com/1",
          "https://a.example.com/2",
          "https://a.example.com/3",
          "https://a.example.com/4",
        ],
      }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.workUrls, /three/i);
  });

  it("does not let a client-supplied status field through the payload", () => {
    const sneaky = { ...valid(), status: "VERIFIED" } as ApplicationInput & { status: string };
    const result = validateApplication(sneaky);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal("status" in result.value, false);
  });

  it("builds public ids and slugs", () => {
    assert.equal(makePublicId("abc-def-1234-5678").startsWith("VA-"), true);
    assert.equal(slugify("Void Caller"), "void-caller");
  });
});
