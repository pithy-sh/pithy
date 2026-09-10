// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **One place words a Cloudflare refusal, and this is what makes that a fact rather than a memory.**
 *
 * `cloudflareRefusal` exists so a fix to the wording reaches all 134 call sites at once, and #534's
 * first round said in as many words that `CloudflareBuildsManager` was "the only path that composed a
 * `CloudflareRequestError` without going through the wrapper". Four others were: `mintToken`, the
 * Stream direct upload, and the two live-integration helpers. The most costly of them was `mintToken`
 * — `pithy token mint` is where an under-scoped bootstrap token is refused first, and on the identical
 * 401 body it still printed one sentence with no code, no link and nothing to do.
 *
 * A hand-built refusal is not merely a duplicate: `cloudflareRequest`'s wrapper opens with
 * `if (error instanceof PithyError) throw error`, so a `PithyError` a call site composed itself
 * **short-circuits the wrapper entirely** and cannot be repaired from one place afterwards. That is
 * why the gate is grep-shaped and repo-wide rather than a review habit — the failure it catches is
 * silent everywhere except the one command an operator runs when nothing else works yet.
 *
 * Scoped to the constructor rather than to the class: importing `CloudflareRequestError` to *narrow* a
 * caught error is right and `buildsManager`'s `hasErrorCode` does it.
 *
 * Scoped to this package's `src` too, because that is where the refusal paths are — every Cloudflare
 * call in the kit goes through a manager here. One construction lives outside it,
 * `@pithy-sh/media`'s `retryPolicy.test.ts`, and it is a *fixture* handed to a fault classifier: it
 * asserts what the code means to a retry policy, and words nothing at an operator.
 */

/** This package's `src`, from the test's own location — never a cwd, which differs under Turbo. */
const SRC = join(import.meta.dirname, "..");

/** Where the wording lives. The one file allowed to construct the refusal it composes. */
const COMPOSER = join(SRC, "client", "errors.ts");

/** This gate itself, which has to spell the pattern it bans in order to look for it. */
const THIS_GATE = import.meta.filename;

/**
 * Every `.ts` under `src`, tests included — a fixture that builds one by hand is the same defect.
 *
 * Node's own recursive listing rather than a walk written here: `cli`'s `ci/sourceFiles.ts` is the
 * repository's shared walker and `@pithy-sh/cloudflare` cannot depend on the CLI, so the choice is
 * Node's recursion or a sixth private copy of one.
 */
function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => join(dir, entry));
}

describe("every Cloudflare refusal is worded in one place", () => {
  it("no file but the composer constructs a `CloudflareRequestError`", () => {
    const offenders = sources(SRC)
      .filter((path) => path !== COMPOSER && path !== THIS_GATE)
      .filter((path) => readFileSync(path, "utf8").includes("new CloudflareRequestError("))
      .map((path) => path.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });

  it("the sweep really reads this package, so an empty result means something", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(100);
    // The composer is in the set and does construct one — so the filter above is what excludes it,
    // not a path that stopped matching anything.
    expect(files).toContain(COMPOSER);
    expect(readFileSync(COMPOSER, "utf8")).toContain("new CloudflareRequestError(");
  });

  it("every raw-`fetch` manager that refuses composes through the shared wrapper", () => {
    // The four paths that were composing their own. Named individually because a sweep that only says
    // "none left" cannot say which ones were fixed, and a re-regression in any single one of them would
    // otherwise read as an unchanged green.
    for (const path of [
      join(SRC, "tokens", "accountTokensManager.ts"),
      join(SRC, "media", "assetSeeder.ts"),
      join(SRC, "workers", "buildsManager.ts"),
      join(SRC, "test-utils", "emailRoutingRules.ts"),
      join(SRC, "test-utils", "inboundRecorder.ts"),
    ]) {
      expect(readFileSync(path, "utf8")).toContain("cloudflareRefusal({");
    }
  });
});
