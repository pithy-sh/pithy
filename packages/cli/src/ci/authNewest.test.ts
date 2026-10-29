// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * **`Auth at the newest Better Auth` moves every Better Auth package auth depends on.**
 *
 * The job runs `bun update` on a list of package names, and `bun update` moves only the packages it names. A
 * `@better-auth/*` dependency left off the list stays at the locked version while `better-auth` moves, and its
 * types then describe a second, older Better Auth: the build fails on a mismatch no adopter's install has, since a
 * fresh install resolves them all to the top of their ranges together. So the list is held to auth's
 * `dependencies`, and a new Better Auth package there has to join it.
 *
 * The workflow is read as text, for the reason `mainRuleset.test.ts` gives.
 */

/** The repository root. This file lives at `packages/cli/src/ci/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** `better-auth` and every `@better-auth/*` package in auth's runtime `dependencies`. */
function betterAuthDependencies(): string[] {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, "packages", "auth", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(manifest.dependencies ?? {})
    .filter((name) => name === "better-auth" || name.startsWith("@better-auth/"))
    .sort();
}

/** The package names on the `bun update` line of the `auth-newest` job. */
function updatedPackages(): string[] {
  const workflow = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const job = /^ {2}auth-newest:\n([\s\S]*?)(?=^ {2}\S)/m.exec(workflow)?.[1];
  if (!job) throw new Error("ci.yml has no `auth-newest` job.");
  const lines = [...job.matchAll(/^\s*bun update (.+)$/gm)].map((match) => match[1] ?? "");
  expect(lines).toHaveLength(1);
  return (lines[0] ?? "").trim().split(/\s+/).sort();
}

describe("the newest-Better-Auth job", () => {
  test("auth depends on Better Auth packages at all", () => {
    expect(betterAuthDependencies()).toContain("better-auth");
  });

  test("updates exactly the Better Auth packages auth depends on", () => {
    expect(updatedPackages()).toEqual(betterAuthDependencies());
  });
});
