// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const run = promisify(execFile);

/** `packages/cli/src/ci` → the repository. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The derivation CI plans with. Run as a subprocess: it is not under this package's `rootDir`. */
const SCRIPT = join(REPO_ROOT, ".github", "scripts", "crossPackageReads.ts");

type Read = { package: string; directory: string; file: string; target: string };

/** Every cross-package read the script finds in this tree. */
async function reads(): Promise<Read[]> {
  const { stdout } = await run("bun", [SCRIPT, "--json"], { cwd: REPO_ROOT });
  return JSON.parse(stdout) as Read[];
}

/** The `--filter=` arguments CI would add for a diff touching exactly `changed`. */
async function filtersFor(changed: readonly string[]): Promise<string[]> {
  const child = run("bun", [SCRIPT, "--filters"], { cwd: REPO_ROOT });
  child.child.stdin?.end(`${changed.join("\n")}\n`);
  const { stdout } = await child;
  return stdout.split("\n").filter(Boolean);
}

/**
 * The record. **This is a list, and it is meant to be.**
 *
 * Everything else about this mechanism is derived — the script re-reads the test files on every CI
 * run, so a cross-package read added tomorrow is planned tomorrow with nothing to remember. That is
 * what stops #148 and #173 from recurring. But "derived" and "unnoticed" are the same thing unless
 * something says out loud what the derivation currently finds, so this is the tripwire: a path no
 * test read across a boundary before fails here, and gets added by a human who meant to.
 *
 * These are the exact paths, because they are what the planner matches a changed file against. A
 * second test reading `packages/**` adds no entry; a test reading somewhere new does.
 *
 * Each key is a path read from outside the package that reads it. Each value is why.
 */
const RECORD: Record<string, string> = {
  ".": "The repo root. `project/atomic.test.ts`'s rename and recursive-delete tripwires walk every source file in the tree, and the docs tests hold `README.md` and `docs/` to the CLI's real output.",
  "docs/CLI.md": "`terminal/styleDocs.test.ts` holds the documented styles to the ones the terminal module exports.",
  "docs/FIXTURES.md":
    "`@pithy-sh/cloudflare`'s `test-utils/fixtures.test.ts` holds every live fixture to the section its skip message cites. A skip line naming a document nobody wrote is worse than no line at all, so the citation is a gate rather than a convention — and it only means anything if editing the document re-runs it (#106).",
  "node_modules/.bin/biome":
    "The workspace's Biome, run as a subprocess. `project/jsonc.test.ts` and `ui/formatting.test.ts` assert that a config Pithy writes is one the formatter the kit scaffolds would print unchanged (#249), and the only honest way to answer that is to ask the formatter.",
  "packages/core/src/error/cause.ts":
    "`project/config.test.ts` asserts core's record of how Bun reports a build failure — that it wraps two or more diagnostics in an `AggregateError`, and re-throws it emptied on every import after the first (#223). The assertion belongs beside the classifier that depends on it, and the fact belongs in core, so the read crosses.",
  packages:
    "Every package's shipped files, read from the source tree rather than `node_modules`: the manifest-width sweep (#173), the migration-order scan, the capability catalog, and the stamped versions.",
  "packages/payments/pithy.manifest.json":
    "`capabilities/manifests.test.ts` names this one manifest rather than sweeping them all, because `billingSubject` is the first **required** config option the kit ships — no default, a closed set of two — and it is the whole reason a manifest can express one (#412). The repo-wide sweep above proves every manifest still parses; this proves that this option is still required, which is the feature. Editing the manifest must therefore re-run the CLI's suite, and `packages` alone does not say so specifically enough to survive somebody narrowing it.",
  "templates/starter": "The tree `pithy init` copies (#148). `project/scaffold.test.ts` reads it whole.",
  "templates/starter/apps/api/package.json":
    "`project/scaffold.test.ts` — the dependencies a scaffolded Worker starts with.",
  "templates/starter/apps/api/tsconfig.json":
    "`project/workerScaffold.test.ts` — the Worker's compiler options survive scaffolding.",
  "templates/starter/apps/api/wrangler.jsonc":
    "`project/scaffoldParity.test.ts` — `init` string-replaces three fields here and stamps the rest.",
  "templates/starter/gitignore":
    "`seed/prepare.test.ts` — what a scaffolded project ignores, including its dev secrets.",
};

describe("the cross-package reads CI plans from", () => {
  test("every package that asserts about another package's files is planned by name", async () => {
    // `--affected` maps a changed file to its owning package and that package's dependents, and
    // nothing else. A package appearing here is one whose suite that model cannot reach.
    //
    // `@pithy-sh/browser-scopes` is the second, and it is here for the same reason the CLI is: its gates
    // read every capability's source to find every control-plane scope the kit declares (#315) and every
    // response schema it ships (#419), so either landing in a package this one does not depend on is a
    // change its suite must re-check.
    //
    // `@pithy-sh/cloudflare` is the third, and it reads exactly one thing: `docs/FIXTURES.md`, the
    // document every live-fixture skip message cites. The gate is that the cited section exists, and a
    // gate on a document is worthless unless editing the document runs it (#106).
    //
    // `@pithy-sh/ui-react` is the fourth, and it is #391's ledger. `seededGates.test.ts` records, for
    // every seeded file, the gate that holds it — and for the ones the kit keeps, the path of that gate
    // in another package. A ledger entry pointing at a renamed file rots into a subject that reads as
    // held, so the entry resolves the path; and resolving it is worth nothing unless renaming the gate
    // re-runs the ledger.
    expect([...new Set((await reads()).map((read) => read.package))].sort()).toEqual([
      "@pithy-sh/browser-scopes",
      "@pithy-sh/cli",
      "@pithy-sh/cloudflare",
      "@pithy-sh/ui-react",
    ]);
  });

  test("only these paths are read across a package boundary", async () => {
    const found = [...new Set((await reads()).map((read) => read.target))].sort();
    expect(found).toEqual(Object.keys(RECORD).sort());
  });

  test("every recorded read resolves to something that exists", async () => {
    // The rule that separates a path a test READS from a path a test REJECTS.
    // `testers/src/crypto/token.test.ts` feeds `"../../../etc/passwd"` to a traversal guard as
    // hostile input; it resolves to `packages/etc/passwd`, which is nothing, so it is not a read.
    for (const read of await reads()) expect(existsSync(join(REPO_ROOT, read.target))).toBe(true);
  });

  test("the traversal fixture is not mistaken for a read", async () => {
    expect((await reads()).some((read) => read.target.includes("etc/passwd"))).toBe(false);
  });
});

describe("what CI plans for a change", () => {
  test("editing any shipped manifest plans the CLI — the sweep that reads them all (#173)", async () => {
    const manifests = readdirSync(join(REPO_ROOT, "packages"))
      .map((name) => `packages/${name}/pithy.manifest.json`)
      .filter((path) => existsSync(join(REPO_ROOT, path)));

    expect(manifests.length).toBeGreaterThan(10);
    for (const manifest of manifests) {
      // One at a time. A manifest whose package the CLI happens to depend on would be planned by
      // `--affected` anyway; asserting them as a batch would hide the ones that are not.
      expect(await filtersFor([manifest])).toContain("--filter=@pithy-sh/cli");
    }
    // **A hang ceiling, from the #361 population sweep — this was the next case due to go red.**
    // Every `filtersFor` spawns `scripts/planShards.ts` afresh, so this case is one full bun start and
    // one full tree walk *per manifest*, twenty-odd of them in a row. Measured: 8,692ms at load average
    // 16, against the config's 30,000ms default — a 3.45x margin, already inside the band that
    // `dashboard#63` measured for this machine. Under `bun run test --force` at load 66 this file went
    // from 13,278ms to 40,165ms (3.0x), which puts this case around 26s. It passed by about 13%.
    //
    // 120_000 matches the other spawn-heavy cases in this package and is ~14x the measured cost, so it
    // catches a hang and nothing else. **The real fix is upstream of the budget and is not done here:**
    // the twenty-odd spawns ask the same script the same kind of question and re-walk the same
    // unchanged tree every time, which is `dashboard#63`'s doubled work exactly. A `--filters` mode that
    // answered many change-sets from one walk would take this case to a single spawn. That is a change
    // to a CI script rather than to a test, so it belongs in its own issue with its own review.
  }, 120_000);

  test("editing the starter template still plans the CLI (#148, kept)", async () => {
    expect(await filtersFor(["templates/starter/pithy.config.ts"])).toContain("--filter=@pithy-sh/cli");
  });

  test("editing any package's source plans the CLI — the tripwires walk all of them", async () => {
    expect(await filtersFor(["packages/leaderboard/src/capability.ts"])).toContain("--filter=@pithy-sh/cli");
  });

  test("editing the fixture document plans the package whose gate cites it (#106)", async () => {
    // The citation gate lives in `@pithy-sh/cloudflare` and the document lives in `docs/`, which no
    // dependency edge connects. Without this, deleting a section leaves every skip message pointing at
    // nothing and CI has no reason to notice — #52's defect class, and the reason the gate exists.
    expect(await filtersFor(["docs/FIXTURES.md"])).toContain("--filter=@pithy-sh/cloudflare");
  });

  test("editing any package's source plans the browser-scope gate too (#315)", async () => {
    // Asserted against a capability that declares no scope at all. The gate's expected set is derived
    // from whatever the tree declares, so the package that could newly declare one is exactly the
    // package `--affected` would not reach — planning only the scope-bearing ones would leave the hole.
    expect(await filtersFor(["packages/leaderboard/src/capability.ts"])).toContain("--filter=@pithy-sh/browser-scopes");
  });
});
