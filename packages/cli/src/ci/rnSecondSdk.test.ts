// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * **The React Native templates are typechecked against two Expo SDKs, and CI fails on either.**
 *
 * The pinned SDK is the workspace's own, checked by `@pithy-sh/ui-react-native`'s `typecheck` through
 * `tsconfig.templates.json`. The next one is checked by the `rn-second-sdk` job running
 * `packages/ui-react-native/scripts/typecheckSecondSdk.ts`. This holds the job to that script and to the `CI` gate.
 *
 * The workflow is read as text, for the reason `mainRuleset.test.ts` gives.
 */

/** The repository root. This file lives at `packages/cli/src/ci/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const WORKFLOW = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
const SCRIPT = "packages/ui-react-native/scripts/typecheckSecondSdk.ts";

/** The body of one top-level job in `ci.yml`. */
function job(key: string): string {
  const body = new RegExp(`^ {2}${key}:\\n([\\s\\S]*?)(?=^ {0,2}\\S|(?![\\s\\S]))`, "m").exec(WORKFLOW)?.[1];
  if (!body) throw new Error(`ci.yml has no \`${key}\` job.`);
  return body;
}

describe("the templates on two Expo SDKs", () => {
  test("the pinned SDK: the package typecheck runs the templates' program", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "packages", "ui-react-native", "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts.typecheck).toContain("tsconfig.templates.json");
  });

  test("the next SDK: the job runs the second-SDK script, which exists", () => {
    expect(job("rn-second-sdk")).toMatch(new RegExp(`^\\s*run: bun ${SCRIPT.replaceAll(".", "\\.")}$`, "m"));
    expect(existsSync(resolve(REPO_ROOT, SCRIPT))).toBe(true);
  });

  test("the job builds the packages the templates import before it checks", () => {
    const body = job("rn-second-sdk");
    expect(body.indexOf('--filter="@pithy-sh/ui-react-native^..."')).toBeGreaterThan(-1);
    expect(body.indexOf('--filter="@pithy-sh/ui-react-native^..."')).toBeLessThan(body.indexOf(SCRIPT));
  });

  test("the CI gate waits on the job", () => {
    expect(job("ci")).toMatch(/needs: \[[^\]]*\brn-second-sdk\b[^\]]*\]/);
  });
});
