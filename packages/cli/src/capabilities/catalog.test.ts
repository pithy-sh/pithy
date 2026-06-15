import { describe, expect, test } from "vitest";
import { buildCatalogListing, CATALOG } from "./catalog";

describe("CATALOG", () => {
  test("every entry is a @pithy-sh package with a one-line rationale", () => {
    expect(CATALOG.length).toBeGreaterThan(0);
    for (const entry of CATALOG) {
      expect(entry.package).toBe(`@pithy-sh/${entry.name}`);
      expect(entry.whenToEnable.length).toBeGreaterThan(0);
    }
  });
});

describe("buildCatalogListing", () => {
  test("marks installed capabilities and leaves the rest unmarked", () => {
    const listing = buildCatalogListing(new Set(["auth"]));
    const auth = listing.find((e) => e.name === "auth");
    const storage = listing.find((e) => e.name === "storage");
    expect(auth?.installed).toBe(true);
    expect(storage?.installed).toBe(false);
  });

  test("returns one row per catalog entry, in catalog order", () => {
    const listing = buildCatalogListing(new Set());
    expect(listing.map((e) => e.name)).toEqual(CATALOG.map((e) => e.name));
    expect(listing.every((e) => e.installed === false)).toBe(true);
  });
});
