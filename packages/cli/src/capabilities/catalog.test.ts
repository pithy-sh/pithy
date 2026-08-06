// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildCatalogListing, CAPABILITY_SCOPE, CATALOG, capabilityPackageDir } from "./catalog";
import { capabilityImportSpecifier } from "./configImports";

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

/** `packages/` — this file lives at `packages/cli/src/capabilities/`. */
const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** An `export { a, type B, c as d } from "./x";` clause — the only export form the barrels use. */
const EXPORT_CLAUSE = /^export\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/gm;

/** A factory declared in the barrel itself: `export function auth(...)`, `export const auth = ...`. */
const EXPORT_DECLARATION = /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * The value names a barrel publishes. Aliases resolve to the published name; `type` specifiers drop,
 * because a capability factory is a value and a type-only export would not satisfy the import.
 *
 * **Source text, not a module load.** Half these barrels reach `cloudflare:workers` on import and no
 * factory runs without config — `migrations/orders.test.ts` reads source across the packages for the
 * same reason. The TypeScript API is not an alternative either: TS 7 ships no `createSourceFile`.
 * What the text cannot see — whether the module a clause re-exports from really has the name —
 * `bun run typecheck` already fails on.
 *
 * `export * from "./capability"` is deliberately not understood. A barrel that hides the catalog's
 * factory behind a star fails here, and should: the entrypoint is the documented contract, so it
 * names what it publishes.
 */
function exportedValues(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(EXPORT_CLAUSE)) {
    for (const specifier of (match[1] ?? "").split(",")) {
      const trimmed = specifier.trim();
      if (trimmed === "" || trimmed.startsWith("type ")) continue;
      const parts = trimmed.split(/\s+as\s+/);
      const published = (parts[1] ?? parts[0] ?? "").trim();
      if (published !== "") names.add(published);
    }
  }
  for (const match of source.matchAll(EXPORT_DECLARATION)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

/**
 * Every catalog entry must be *addable*, and that is a claim about another package's files.
 *
 * `pithy add` writes `import { <name> } from "<package>/src/index";` into the adopter's
 * `pithy.config.ts`. `@pithy-sh/secrets` shipped with no `src/index.ts` at all, so `pithy add secrets`
 * wrote a config that could not load and every later `pithy` command failed on it — a defect no test
 * in either package could see, because each one only ever looked at its own tree. This is the test that
 * looks across.
 */
describe("every catalog entry is addable", () => {
  for (const entry of CATALOG) {
    const specifier = capabilityImportSpecifier(entry.package);

    test(`${entry.name} resolves at ${specifier} and exports ${entry.name}`, () => {
      const pkgDir = join(PACKAGES, capabilityPackageDir(entry.name));
      const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
        name?: string;
        exports?: Record<string, unknown>;
      };

      // The catalog's package name is the one npm publishes, and the `./src/*` subpath export is what
      // makes `<package>/src/index` reachable at all. Its spelling — a string, or a conditional map —
      // is the package's own business, so only its presence is asserted; pinning the string would fail
      // a refactor that resolves identically.
      expect(pkg.name).toBe(entry.package);
      expect(
        pkg.exports?.["./src/*"],
        `${entry.package} declares no ./src/* export, so ${specifier} cannot resolve.`,
      ).toBeDefined();

      // Which maps the specifier onto exactly one file. Derived from the string `add` writes, so a
      // change to that string is a change here.
      const barrel = join(pkgDir, `${specifier.slice(`${entry.package}/`.length)}.ts`);
      expect(
        existsSync(barrel),
        `${specifier} has no file. pithy add ${entry.name} writes a config that cannot load.`,
      ).toBe(true);

      expect(
        [...exportedValues(readFileSync(barrel, "utf8"))],
        `${specifier} does not export the ${entry.name} factory that pithy add imports from it.`,
      ).toContain(entry.name);
    });
  }
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
