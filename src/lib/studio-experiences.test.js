import { describe, expect, it } from "vitest";
import { EXPERIENCE_CATEGORIES } from "../domain/models.js";
import { EXPERIENCE_AUDIO_ROLE, FULL_TRACK_ROLE, experienceIdFor, planCatalogExperiences } from "./studio-experiences.js";

const FULL = { assetId: "asset-master", mediaType: "AUDIO", contentType: "audio/x-wav", filename: "master.wav" };
const DEMO = { assetId: "asset-demo", mediaType: "DEMO", contentType: "audio/x-wav", filename: "demo-30s.wav" };
const base = { editionId: "edition-1", productType: "DEMO", experienceTitle: "Stranger Things", experienceDescription: "Stranger things have happened...", trackTitle: "Forgive & Forget", releaseTitle: "Forgive & Forget" };

describe("catalog experiences planned from the Studio's private files", () => {
  it("uses categories the schema and Studio really support", () => {
    expect(EXPERIENCE_CATEGORIES.FULL_RECORD).toMatchObject({ deliveryType: "AUDIO", supported: true });
    expect(EXPERIENCE_CATEGORIES.DEMO).toMatchObject({ deliveryType: "DEMO", supported: true });
  });

  it("saves the full track and the demo as two separate experiences, each with only its own asset", () => {
    const plans = planCatalogExperiences({ ...base, fullTrack: FULL, experienceAudio: DEMO });
    expect(plans).toHaveLength(2);
    const demo = plans.find((plan) => plan.role === EXPERIENCE_AUDIO_ROLE);
    const full = plans.find((plan) => plan.role === FULL_TRACK_ROLE);

    expect(demo.payload).toMatchObject({ productType: "DEMO", experienceType: "DEMO", title: "Stranger Things", description: "Stranger things have happened..." });
    expect(demo.payload.mediaConfig).toEqual({ protected: true, protectedMedia: [{ assetId: "asset-demo", mediaType: "DEMO", contentType: "audio/x-wav" }], primary: false });

    expect(full.payload).toMatchObject({ productType: "FULL_RECORD", experienceType: "AUDIO", title: "Forgive & Forget", description: "" });
    expect(full.payload.mediaConfig).toEqual({ protected: true, protectedMedia: [{ assetId: "asset-master", mediaType: "AUDIO", contentType: "audio/x-wav" }], primary: true });

    expect(demo.id).not.toBe(full.id);
    expect(JSON.stringify(demo.payload)).not.toContain("asset-master");
    expect(JSON.stringify(full.payload)).not.toContain("asset-demo");
    // The demo's own description is never copied onto the full song.
    expect(JSON.stringify(full.payload)).not.toContain("Stranger");
  });

  it("designates the full track as primary and the demo as explicitly not, whatever the save order", () => {
    const plans = planCatalogExperiences({ ...base, fullTrack: FULL, experienceAudio: DEMO });
    expect(plans.find((plan) => plan.role === FULL_TRACK_ROLE).payload.mediaConfig.primary).toBe(true);
    expect(plans.find((plan) => plan.role === EXPERIENCE_AUDIO_ROLE).payload.mediaConfig.primary).toBe(false);
    // Replacing either file keeps both designations.
    const replaced = planCatalogExperiences({ ...base, fullTrack: { ...FULL, assetId: "asset-master-2" }, experienceAudio: { ...DEMO, assetId: "asset-demo-2" } });
    expect(replaced.map((plan) => [plan.role, plan.payload.mediaConfig.primary]).sort()).toEqual([[EXPERIENCE_AUDIO_ROLE, false], [FULL_TRACK_ROLE, true]]);
  });

  it("gives every role one stable id per edition, so a repeat save cannot add a duplicate", () => {
    const first = planCatalogExperiences({ ...base, fullTrack: FULL, experienceAudio: DEMO }).map((plan) => plan.id);
    const again = planCatalogExperiences({ ...base, fullTrack: FULL, experienceAudio: DEMO }).map((plan) => plan.id);
    expect(again).toEqual(first);
    expect(first).toEqual([experienceIdFor("edition-1", EXPERIENCE_AUDIO_ROLE), experienceIdFor("edition-1", FULL_TRACK_ROLE)]);
    expect(planCatalogExperiences({ ...base, editionId: "edition-2", fullTrack: FULL }).map((plan) => plan.id)).not.toContain(first[1]);
  });

  it("replacing one file changes only that role's asset", () => {
    const before = planCatalogExperiences({ ...base, fullTrack: FULL, experienceAudio: DEMO });
    const after = planCatalogExperiences({ ...base, fullTrack: FULL, experienceAudio: { ...DEMO, assetId: "asset-demo-2" } });
    expect(after.find((plan) => plan.role === FULL_TRACK_ROLE)).toEqual(before.find((plan) => plan.role === FULL_TRACK_ROLE));
    expect(after.find((plan) => plan.role === EXPERIENCE_AUDIO_ROLE).payload.mediaConfig.protectedMedia[0].assetId).toBe("asset-demo-2");
  });

  it("keeps the previous single-file behavior when only one file exists", () => {
    const [onlyDemo] = planCatalogExperiences({ ...base, experienceAudio: DEMO });
    expect(onlyDemo).toMatchObject({ role: EXPERIENCE_AUDIO_ROLE, payload: { productType: "DEMO", experienceType: "DEMO", title: "Stranger Things" } });
    // A demo saved alone stays undesignated, exactly as before.
    expect(onlyDemo.payload.mediaConfig).not.toHaveProperty("primary");

    const [onlyFull] = planCatalogExperiences({ ...base, productType: "UNRELEASED_TRACK", fullTrack: FULL });
    expect(onlyFull).toMatchObject({ role: FULL_TRACK_ROLE, payload: { productType: "UNRELEASED_TRACK", experienceType: "AUDIO", title: "Stranger Things", description: "Stranger things have happened..." } });
  });

  it("never types the full track as a demo when no demo file exists", () => {
    const [only] = planCatalogExperiences({ ...base, productType: "DEMO", fullTrack: FULL });
    expect(only.payload).toMatchObject({ productType: "FULL_RECORD", experienceType: "AUDIO", title: "Forgive & Forget", description: "" });
  });

  it("refuses an experience file whose uploaded type no longer matches the selected category", () => {
    expect(() => planCatalogExperiences({ ...base, productType: "FULL_RECORD", fullTrack: FULL, experienceAudio: DEMO })).toThrow(/uploaded as DEMO/);
  });

  it("plans nothing without a private file, and never carries the public preview", () => {
    expect(planCatalogExperiences({ ...base })).toEqual([]);
    const text = JSON.stringify(planCatalogExperiences({ ...base, fullTrack: FULL, experienceAudio: DEMO }));
    expect(text).not.toMatch(/preview/i);
    expect(() => planCatalogExperiences({ ...base, editionId: "", fullTrack: FULL })).toThrow(/Save the track draft/);
  });
});
