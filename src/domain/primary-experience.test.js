import { describe, expect, it } from "vitest";
import { getEditionCatalog, orderExperiences, primaryExperience } from "./models.js";
import { baseCatalogs, mapPublishedCatalog } from "../lib/catalog-source.js";

const full = { id: "full", primary: true };
const demo = { id: "demo", primary: false };

describe("primaryExperience", () => {
  it("returns the designated experience wherever it sorts", () => {
    expect(primaryExperience([demo, full]).id).toBe("full");
    expect(primaryExperience([full, demo]).id).toBe("full");
    expect(primaryExperience([{ id: "other" }, demo, full]).id).toBe("full");
  });

  it("never falls back to another experience once an edition designates a primary", () => {
    expect(primaryExperience([demo])).toBeNull(); // full track missing: the demo is not promoted
    expect(primaryExperience([demo, { id: "x", primary: false }])).toBeNull();
    expect(primaryExperience([{ id: "a", primary: true }, { id: "b", primary: true }])).toBeNull(); // ambiguous
  });

  it("falls back to the first listed when nothing is designated (older releases, Genesis)", () => {
    expect(primaryExperience([{ id: "a" }, { id: "b" }]).id).toBe("a");
    expect(primaryExperience([{ id: "only" }]).id).toBe("only");
    expect(primaryExperience([])).toBeNull();
    expect(primaryExperience(undefined)).toBeNull();
  });

  it("treats a designated primary next to undesignated rows as the primary", () => {
    expect(primaryExperience([{ id: "legacy" }, full]).id).toBe("full");
  });
});

describe("orderExperiences", () => {
  it("puts the primary first and keeps everything else in its original order", () => {
    expect(orderExperiences([{ id: "a" }, demo, { id: "b" }, full]).map((item) => item.id)).toEqual(["full", "a", "demo", "b"]);
  });

  it("leaves undesignated lists and single experiences untouched", () => {
    const list = [{ id: "a" }, { id: "b" }];
    expect(orderExperiences(list)).toEqual(list);
    expect(orderExperiences([demo]).map((item) => item.id)).toEqual(["demo"]);
    expect(orderExperiences([demo, { id: "x", primary: false }]).map((item) => item.id)).toEqual(["demo", "x"]);
  });
});

describe("public listing rows", () => {
  const row = (id, primary) => ({ id, edition_id: "e1", title: id, experience_type: "AUDIO", protected: true, gated: true, ...(primary === undefined ? {} : { primary_experience: primary }) });

  it("carries only an explicit true or false designation onto the catalog experience", () => {
    const { experiences } = mapPublishedCatalog({ experiences: [row("a", true), row("b", false), row("c")] });
    expect(experiences.find((item) => item.id === "a").primary).toBe(true);
    expect(experiences.find((item) => item.id === "b").primary).toBe(false);
    expect(experiences.find((item) => item.id === "c")).not.toHaveProperty("primary");
  });
});

describe("Genesis and legacy catalogs", () => {
  it("select exactly the experience they selected before designations existed", () => {
    let checked = 0;
    for (const catalog of baseCatalogs()) {
      for (const edition of catalog.editions || []) {
        const experiences = getEditionCatalog(catalog, edition.id).experiences;
        expect(experiences.some((item) => "primary" in item)).toBe(false);
        expect(primaryExperience(experiences)).toBe(experiences[0] ?? null);
        expect(orderExperiences(experiences)).toEqual(experiences);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
