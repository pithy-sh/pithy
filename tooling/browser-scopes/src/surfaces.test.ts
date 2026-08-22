// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { responseModules, schemaModules, scopeHomes, specifierFor } from "./surfaces";

/**
 * The three derivations, on a tree written for the purpose.
 *
 * `coverage.test.ts` and `browserSurface.test.ts` run these over `packages/` and assert about what they
 * find there, which proves the derivations answer *this* repository. It does not prove what they refuse:
 * every near-miss the real tree happens not to contain — a `schemas.ts` that is not a route contract, a
 * scope-shaped constant in a test file, a declaration wearing the wrong type — is a case only a fixture
 * can put in front of them. Both halves are needed, and they are the same pair `program.test.ts` and
 * `browserSurface.test.ts` already form one level up.
 *
 * Nothing here climbs out of this file's own package, so `.github/scripts/crossPackageReads.ts` records
 * no read for it. The literal that reaches `packages/` stays in the two suites that assert about it.
 */

/** A tree with one of each shape, and one of each near-miss. */
let root: string;

/** `<root>/<path>`, with its parents, holding `text`. */
function write(path: string, text: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

/** A path relative to the fixture root, in this platform's separators. */
function at(path: string): string {
  return join(root, path);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pithy-surfaces-"));

  write("alpha/src/http/responses.ts", "export const a = 1;\n");
  write("alpha/src/http/schemas.ts", "export const b = 1;\n");
  write("alpha/src/http/scopes.ts", 'export const ALPHA_READ_SCOPE: ControlPlaneScope = "alpha:read";\n');
  // The four capabilities #430 found: a scope home whose file is called `guards.ts` and holds no guard.
  write("beta/src/http/guards.ts", 'export const BETA_READ_SCOPE: ControlPlaneScope = "beta:read";\n');

  // Near-misses, each one a way a derivation could be wrong and look right.
  write("gamma/src/data/schemas.ts", "export const c = 1;\n"); // not a route contract
  write("gamma/src/http/handlers.ts", "export const d = 1;\n"); // right folder, wrong file
  write("gamma/src/http/scopes.test.ts", 'export const FAKE_SCOPE: ControlPlaneScope = "fake:read";\n');
  write("gamma/src/http/other.ts", 'export const PLAY_SCOPE = "https://example.test/auth";\n');
  write("gamma/src/http/lower.ts", 'export const readScope: ControlPlaneScope = "gamma:read";\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a family is derived from the tree, and the near-misses are refused", () => {
  it("finds a response module only at the path §HTTP gives it", () => {
    // `src/data/schemas.ts` next door is the case: the base name is the same and the module is not the
    // capability's request contract. The folder is half the derivation, and dropping it would put an
    // arbitrary module under a browser program and call that coverage.
    expect(responseModules(root)).toEqual([at("alpha/src/http/responses.ts")]);
    expect(schemaModules(root)).toEqual([at("alpha/src/http/schemas.ts")]);
  });

  it("finds a scope home by what it declares, whatever the file is called", () => {
    // The whole reason this is not a path glob. `beta/src/http/guards.ts` is a scope home and
    // `gamma/src/http/handlers.ts` is not, and no filename says either.
    expect([...scopeHomes(root).keys()].sort()).toEqual([
      at("alpha/src/http/scopes.ts"),
      at("beta/src/http/guards.ts"),
    ]);
  });

  it("counts a declaration only when the annotation is there, and never in a test", () => {
    const homes = scopeHomes(root);
    expect(homes.get(at("alpha/src/http/scopes.ts"))).toEqual(["ALPHA_READ_SCOPE"]);
    // A `_SCOPE` suffix is not the marker — a Google OAuth URL and an npm namespace both carry one — and
    // a scope-shaped fixture inside a `.test.ts` is not the contract the kit ships.
    expect([...homes.keys()]).not.toContain(at("gamma/src/http/other.ts"));
    expect([...homes.keys()]).not.toContain(at("gamma/src/http/scopes.test.ts"));
    // Lowercase is not how a constant is spelled, so it is not one of these.
    expect([...homes.keys()]).not.toContain(at("gamma/src/http/lower.ts"));
  });

  it("spells a module as the specifier a fixture imports", () => {
    expect(specifierFor(root, at("alpha/src/http/responses.ts"))).toBe("@pithy-sh/alpha/src/http/responses");
  });
});
