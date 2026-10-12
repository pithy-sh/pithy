// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { olderThan } from "../nodeFloor";

/**
 * **One Bun, everywhere the kit is built (#709).**
 *
 * The kit pinned 1.3.14 in eleven places while the workstation ran 1.4.2, and the two disagreed on the
 * error shapes `core/src/error/cause.ts` reads. CI stayed green only because it ran the old one. So the
 * pin is one fact: the root `packageManager` names it, and every `bun-version:` in every workflow repeats
 * it exactly. A workflow left behind on a bump is the drift this closes, and it would be green.
 *
 * The workflows are read as text, for the reason `mainRuleset.test.ts` gives.
 */

/** The repository root. This file lives at `packages/cli/src/ci/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const WORKFLOWS = resolve(REPO_ROOT, ".github", "workflows");

/** The root manifest's two statements about Bun. */
function manifest(): { packageManager?: string; engines?: { bun?: string } } {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
}

/** The exact version `packageManager` pins, e.g. `1.4.2` from `bun@1.4.2`. */
function pinned(): string {
  const { packageManager } = manifest();
  const version = /^bun@(\d+\.\d+\.\d+)$/.exec(packageManager ?? "")?.[1];
  if (!version) throw new Error(`Cannot read an exact Bun version from "${packageManager}".`);
  return version;
}

/** The floor `engines.bun` states, e.g. `[1, 4, 0]` from `>=1.4.0`. It is the only statement of it. */
function floor(): number[] {
  const range = manifest().engines?.bun;
  const version = /^>=(\d+\.\d+\.\d+)$/.exec(range ?? "")?.[1];
  if (!version) throw new Error(`Cannot read a Bun floor from engines.bun "${range}".`);
  return version.split(".").map(Number);
}

/** Every `bun-version:` value in one workflow, unquoted. */
function bunVersions(workflow: string): string[] {
  return [...workflow.matchAll(/^\s*bun-version:\s*["']?([^"'\s#]+)["']?/gm)].map((match) => match[1] ?? "");
}

const workflowFiles = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));

describe("the Bun pin", () => {
  test("packageManager names an exact version", () => {
    expect(pinned()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // The kit is built on a runtime its own floor admits, never on one it tells adopters to upgrade from.
  test("the pin is at or above the floor engines.bun states", () => {
    expect(olderThan(pinned().split(".").map(Number), floor())).toBe(false);
  });

  test.each(workflowFiles)("every bun-version in %s is the packageManager pin", (name) => {
    const versions = bunVersions(readFileSync(resolve(WORKFLOWS, name), "utf8"));
    for (const version of versions) expect(version, name).toBe(pinned());
  });

  // The floor: a `bun-version` this pattern stopped matching would let every assertion above pass on
  // nothing. These three hold the most setup-bun steps, so each must still be found.
  test.each(["ci.yml", "integration.yml", "release.yml"])("%s sets up Bun, and this test can see it", (name) => {
    expect(bunVersions(readFileSync(resolve(WORKFLOWS, name), "utf8")).length).toBeGreaterThan(0);
  });

  test("reads a quoted, an unquoted and a commented value alike", () => {
    expect(bunVersions('  bun-version: 1.4.2\n  bun-version: "1.4.2"\n  bun-version: 1.3.14 # old\n')).toEqual([
      "1.4.2",
      "1.4.2",
      "1.3.14",
    ]);
  });
});
