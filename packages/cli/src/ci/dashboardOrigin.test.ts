// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resolve } from "node:path";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { describe, expect, test } from "vitest";
import { sourceFiles } from "./sourceFiles";

/**
 * **Which dashboard a command talks to is decided in one place — `#614`.**
 *
 * Four subcommands each built their own client from `args.origin`, and the flag's absence meant the
 * hosted dashboard. So `status --verify` asked `app.pithy.sh` about a connection registered against a
 * self-hosted one, could not reach a host that was never involved, and reported that the *connection*
 * needed reconnecting. The fix was one resolver; this is what keeps it one.
 *
 * The rule: **only `commands/dashboard.ts`'s own factory names an origin when it builds a client**, and
 * it gets that origin from `resolveDashboardOrigin`. A fifth subcommand that reads the flag directly is
 * the regression, and it is invisible in review because it looks exactly like the four that were there.
 *
 * ## What this cannot see
 *
 * Stated, because a gate that reads source text always has a blind side and a reader deserves to know
 * which one.
 *
 * - A module that builds its origin string in a variable first — `const o = args.origin` — and passes
 *   the variable. The scan reads one expression, not a program.
 * - A caller reaching `httpDashboardClient` through a re-export under another name.
 * - Anything outside `packages/cli/src`, which is the whole of the CLI and the only place this client
 *   is built today.
 */

/** Where the decision is allowed to live, and the module that holds the order. */
const FACTORY = "commands/dashboard.ts";
const RESOLVER = "dashboard/origin.ts";

/** Every shipped CLI source file, comments blanked so a mention in prose is not a call. */
function shipped(): { path: string; source: string }[] {
  return sourceFiles(resolve(import.meta.dirname, ".."))
    .filter((file) => !file.path.endsWith(".test.ts"))
    .map((file) => ({ path: file.path, source: blankComments(file.text) }));
}

/** One path as this file spells them — relative to `packages/cli/src`, forward slashes. */
function spell(path: string): string {
  return path.split(`${["packages", "cli", "src"].join("/")}/`).at(-1) ?? path;
}

describe("the origin a dashboard command talks to is decided once", () => {
  test("no module builds a management client from the flag except the one factory", () => {
    const offenders = shipped()
      .filter(({ source }) => /httpDashboardClient\s*\(\s*[^)]*origin/s.test(source))
      .map(({ path }) => spell(path))
      .filter((path) => path !== FACTORY);

    // A subcommand naming its own origin is the defect: it cannot consult the connection, so it falls
    // back to the hosted dashboard and reports whatever that says about somebody else's deployment.
    expect(offenders).toEqual([]);
  });

  test("the factory reaches the resolver rather than reading the flag into a client itself", () => {
    const factory = shipped().find(({ path }) => spell(path) === FACTORY);
    expect(factory).toBeDefined();
    expect(factory?.source).toContain("resolveDashboardOrigin(");
    // The order lives in the resolver, and the resolver is the module the tests above are about.
    expect(shipped().some(({ path }) => spell(path) === RESOLVER)).toBe(true);
  });

  test("nothing else reads `args.origin`", () => {
    const readers = shipped()
      .filter(({ source }) => /args\s*\.\s*origin/.test(source))
      .map(({ path }) => spell(path))
      .filter((path) => path !== FACTORY);

    expect(readers).toEqual([]);
  });
});
