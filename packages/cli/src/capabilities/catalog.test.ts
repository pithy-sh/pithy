// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { buildCatalogListing, CAPABILITY_SCOPE, CATALOG, capabilityPackageDir } from "./catalog";

/**
 * Capabilities that deliberately ship inside a package not named after them.
 *
 * Listing them here rather than loosening the assertion is the point: a capability whose package stops
 * matching its name breaks `pithy add`'s manifest lookup, so a new one has to be added on purpose.
 */
const SHIPS_INSIDE: Record<string, string> = { controlplane: "@pithy-sh/core" };

describe("CATALOG", () => {
  test("every entry is a @pithy-sh package with a one-line rationale", () => {
    expect(CATALOG.length).toBeGreaterThan(0);
    for (const entry of CATALOG) {
      expect(entry.package).toBe(SHIPS_INSIDE[entry.name] ?? `${CAPABILITY_SCOPE}/${entry.name}`);
      expect(entry.whenToEnable.length).toBeGreaterThan(0);
    }
  });

  test("no two entries claim the same capability name", () => {
    const names = CATALOG.map((entry) => entry.name);
    expect([...new Set(names)]).toEqual(names);
  });
});

describe("capabilityPackageDir", () => {
  test("resolves the directory a capability's manifest lives in", () => {
    // `pithy add` reads `node_modules/@pithy-sh/<dir>/pithy.manifest.json`, so this is the function that
    // decides whether a capability can be added at all.
    expect(capabilityPackageDir("auth")).toBe("auth");
    expect(capabilityPackageDir("controlplane")).toBe("core");
  });

  test("falls back to the capability name when the catalog does not know it", () => {
    // An installed package that landed before its catalog entry did must still resolve.
    expect(capabilityPackageDir("not-in-the-catalog")).toBe("not-in-the-catalog");
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
