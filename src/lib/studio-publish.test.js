import { describe, expect, it } from "vitest";
import { validateReleasePublish } from "./studio-publish.js";

const validInput = {
  release: { title: "Voidcaller Full EP", type: "ep" },
  tracks: [{ title: "Track 1" }, { title: "Track 2" }],
  supply: "25",
  metadata: { artwork: "/assets/voidcaller_art_5.png", includes: ["Full self-titled EP"] },
};

describe("Release-native Studio publish validation", () => {
  it("accepts a valid release without any editionName field", () => {
    expect(validateReleasePublish(validInput)).toMatchObject({
      title: "Voidcaller Full EP",
      supply: "25",
      tracks: validInput.tracks,
    });
  });

  it("requires a release title", () => {
    expect(() => validateReleasePublish({ ...validInput, release: { ...validInput.release, title: "" } })).toThrow("Release title is required.");
  });

  it("requires at least one track", () => {
    expect(() => validateReleasePublish({ ...validInput, tracks: [] })).toThrow("At least one track is required.");
  });

  it("rejects an invalid track", () => {
    expect(() => validateReleasePublish({ ...validInput, tracks: [{ title: "" }] })).toThrow("Track 1 title is required.");
  });
});
