// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * **A Biome config's `$schema` names a version, and the dependency beside it must be that version.**
 *
 * A scaffolded project declared `"@biomejs/biome": "^2.5.8"` and a `$schema` of
 * `https://biomejs.dev/schemas/2.5.8/schema.json`. The caret floats and a URL cannot, so the first
 * `biome check` an adopter ever runs resolved 2.5.12 against a 2.5.8 schema and reported a mismatch
 * (#503's sibling, #498). Nothing fails — it is `info` severity — which is the argument for fixing it
 * rather than against: the very first diagnostic a new project shows its owner is one they are meant to
 * ignore, and that is a habit, not a message. It cost the dashboard real time when it appeared beside a
 * genuine lint failure and the two read as one problem.
 *
 * **Pinned exactly rather than floating the URL**, because only one of the two can move. A `$schema` is a
 * literal, so keeping the pair honest means the dependency stops drifting — which is what a linter wants
 * anyway: a floating formatter is a diff nobody asked for appearing in somebody else's pull request. The
 * cost is a manual bump, and this test is what makes that bump a single, visible act.
 *
 * Asserted over **every** Biome config in the repository, ours included. The starter is the one an adopter
 * meets, and the root is the one that had the identical defect — a rule that held for the template and not
 * for us would be one nobody believes.
 */

/** The repository root, from this file's own location. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** Every Biome config we ship or author, with the manifest that declares the tool for it. */
const PAIRS = [
  { config: "biome.jsonc", manifest: "package.json" },
  { config: "templates/starter/biome.template.jsonc", manifest: "templates/starter/package.json" },
] as const;

/** The version a Biome config's `$schema` URL names. */
function schemaVersion(config: string): string | undefined {
  return /biomejs\.dev\/schemas\/([^/]+)\/schema\.json/.exec(config)?.[1];
}

/** The `@biomejs/biome` range a manifest declares, from either dependency block. */
function declaredRange(manifest: string): string | undefined {
  const parsed = JSON.parse(manifest) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return parsed.devDependencies?.["@biomejs/biome"] ?? parsed.dependencies?.["@biomejs/biome"];
}

describe.each(PAIRS)("$config", ({ config, manifest }) => {
  const configText = readFileSync(join(REPO_ROOT, config), "utf8");
  const manifestText = readFileSync(join(REPO_ROOT, manifest), "utf8");

  test("declares Biome at an exact version, because the schema URL cannot float with it", () => {
    const range = declaredRange(manifestText);
    expect(range).toBeDefined();
    expect(range).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("pins the same version its $schema names", () => {
    expect(schemaVersion(configText)).toBe(declaredRange(manifestText));
  });
});
