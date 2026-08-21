// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeReach, reachCount, reachesWorkersRuntime } from "./reach";

/**
 * The walker, held to each shape it claims to see.
 *
 * `responseCoverage.test.ts` proves the walk sees **this repository**: it asserts that `link/sender.ts`,
 * a real module that really is a Worker's, is caught. That assertion is the one that cannot be faked by
 * a fixture, and it is why it lives there rather than here.
 *
 * It cannot prove the rest. Two of the three ways a module can fail the rule have **no producer in this
 * repository today** — nothing writes a `.js`-suffixed specifier, and no reachable `.ts` carries a
 * reference directive — so a real-tree assertion about either would pass on an empty set forever. Both
 * were reproduced by writing them, and both went straight through the gate: `tsc -p
 * tsconfig.responses.json` exited 0 and the suite reported 7 passed, with the whole #419 chain
 * re-attached underneath. A shape that reaches the gate only when somebody writes it into `packages/` is
 * a shape whose detector is proven here or not at all.
 *
 * So these are fixtures, deliberately, and the division is the one that makes both halves worth having:
 * **the real tree proves the walk is pointed at the repository; the fixtures prove it recognises what it
 * finds there.** A fixture-only suite would prove a regex compiles. A tree-only suite would prove
 * nothing about a spelling nobody has written yet — which is every spelling, right up until the commit
 * that writes it.
 *
 * Each fixture is a whole miniature `packages/`, written to a scratch directory and torn down after.
 * Nothing here reads the kit, which is also why this file adds no cross-package read for
 * `.github/scripts/crossPackageReads.ts` to plan on.
 */

/** A miniature `packages/`, one entry per file: repo-relative path to source. */
type Tree = Readonly<Record<string, string>>;

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "pithy-reach-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Writes `tree` under a fresh directory and answers where its `packages/` root is. */
function write(name: string, tree: Tree): string {
  const packages = join(scratch, name);
  for (const [path, source] of Object.entries(tree)) {
    const file = join(packages, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source, "utf8");
  }
  return packages;
}

/** The header every kit module carries, so a fixture is not accidentally a special case. */
const HEADER = "// SPDX-FileCopyrightText: 2026 Pithy\n// SPDX-License-Identifier: MIT\n\n";

/** A module that is legitimately a Worker's, in the spelling `tsc` under `types: []` cannot object to. */
const SERVER = `${HEADER}import type { D1Database } from "@cloudflare/workers-types";\nexport type Db = D1Database;\n`;

describe("the walk over the import graph", () => {
  it("clears a graph that needs nothing of a Worker", () => {
    // The vacuity floor, and it is the first assertion for a reason: every other test below asserts that
    // something is *found*, and a walker that answered "offender" to everything would pass all of them.
    const packages = write("clean", {
      "alpha/src/http/responses.ts": `${HEADER}import { SCOPE } from "../data/scope";\nexport const wire = SCOPE;\n`,
      "alpha/src/data/scope.ts": `${HEADER}export const SCOPE = "user";\n`,
    });
    const root = join(packages, "alpha/src/http/responses.ts");
    expect(reachesWorkersRuntime(packages, root)).toEqual([]);
    expect(reachCount(packages, root)).toBe(2);
  });

  it("follows a `.js`-suffixed specifier, which is the one that let #419 back through", () => {
    // TypeScript's Bundler resolution follows `../link/sender.js` to the `.ts` beside it. The walker did
    // not: it tried two candidates, matched neither, and discarded the edge with no signal at all. One
    // re-export in this spelling put the whole server data layer back under a response schema with `tsc
    // -p tsconfig.responses.json` at exit 0 and this suite at 7 passed.
    const packages = write("emitted-suffix", {
      "alpha/src/http/responses.ts": `${HEADER}export { Db as LeakDb } from "../data/leak.js";\n`,
      "alpha/src/data/leak.ts": `${HEADER}export type { Db } from "../link/sender.js";\n`,
      "alpha/src/link/sender.ts": SERVER,
    });
    expect(reachesWorkersRuntime(packages, join(packages, "alpha/src/http/responses.ts")).map(describeReach)).toEqual([
      "alpha/src/http/responses.ts -> alpha/src/data/leak.ts -> alpha/src/link/sender.ts " +
        "(imports @cloudflare/workers-types)",
    ]);
  });

  it("throws on a specifier that names something here and resolves to nothing", () => {
    // The general defect, of which `.js` was one instance. Resolving one more suffix closes one hole;
    // failing closed closes the shape. The message names the importer and the specifier, because a
    // tripwire that says only "cannot resolve" sends the reader back to grep for which of forty edges.
    const packages = write("unresolvable", {
      "alpha/src/http/responses.ts": `${HEADER}export { thing } from "../data/gone.mts";\n`,
    });
    expect(() => reachesWorkersRuntime(packages, join(packages, "alpha/src/http/responses.ts"))).toThrow(
      /alpha\/src\/http\/responses\.ts imports "\.\.\/data\/gone\.mts", and tooling\/browser-scopes cannot resolve it/,
    );
  });

  it("throws on a `@pithy-sh` specifier no workspace path answers", () => {
    // A barrel import is not a form this repository writes, so one appearing is a thing to look at. The
    // old resolver returned null for it, which is the same silent drop wearing a cross-package name.
    const packages = write("barrel", {
      "alpha/src/http/responses.ts": `${HEADER}export { thing } from "@pithy-sh/beta";\n`,
    });
    expect(() => reachesWorkersRuntime(packages, join(packages, "alpha/src/http/responses.ts"))).toThrow(
      /imports "@pithy-sh\/beta"/,
    );
  });

  it("throws on a module it cannot read", () => {
    // The same refusal one level up. This walk answers "nothing here needs the Workers runtime", and it
    // may only answer that about a graph it saw. `sourceFiles.ts` tolerates a vanished file because it
    // sweeps a tree other suites scaffold into (#185); this is not that tree.
    const packages = write("unreadable", { "alpha/src/data/scope.ts": `${HEADER}export const SCOPE = "user";\n` });
    expect(() => reachesWorkersRuntime(packages, join(packages, "alpha/src/http/responses.ts"))).toThrow(
      /cannot read alpha\/src\/http\/responses\.ts/,
    );
  });

  it("leaves a specifier that goes to node_modules alone", () => {
    // The one silent drop that stays silent, and the reason fail-closed had to be keyed on *internal*
    // rather than on *unresolved*: `zod` and `hono` resolve to nothing on purpose.
    const packages = write("external", {
      "alpha/src/http/responses.ts": `${HEADER}import { z } from "zod";\nimport "hono";\nexport const wire = z;\n`,
    });
    const root = join(packages, "alpha/src/http/responses.ts");
    expect(reachesWorkersRuntime(packages, root)).toEqual([]);
    expect(reachCount(packages, root)).toBe(1);
  });

  it("catches a reference directive, which defeats `tsc` and the specifier regex at once", () => {
    // The third spelling, and the one that broke the rule as it was written. `tsc` honours a directive
    // whatever `types: []` says, so the DOM-only program compiled a bare `D1Database` and said nothing;
    // the regex above matches statements, so the walk said nothing either. Reproduced exactly that way:
    // exit 0, 7 passed.
    const packages = write("directive", {
      "alpha/src/http/responses.ts": `${HEADER}export { SCOPE } from "../data/leak";\n`,
      "alpha/src/data/leak.ts":
        `${HEADER}/// <reference types="@cloudflare/workers-types" />\n\n` +
        'export const SCOPE = "user";\nexport function q(d1: D1Database) {\n  return d1;\n}\n',
    });
    expect(reachesWorkersRuntime(packages, join(packages, "alpha/src/http/responses.ts")).map(describeReach)).toEqual([
      "alpha/src/http/responses.ts -> alpha/src/data/leak.ts (carries a triple-slash reference directive)",
    ]);
  });

  it("catches a reference directive that names something else entirely", () => {
    // Deliberately not keyed on `@cloudflare/workers-types`. The fault is that a directive widens the
    // ambient environment of every program that reaches the module, past a `types: []` that exists to
    // say no — which is true of `vite/client` in a kit module for exactly the same reason.
    const packages = write("directive-other", {
      "alpha/src/http/responses.ts": `${HEADER}export { SCOPE } from "../data/leak";\n`,
      "alpha/src/data/leak.ts": `${HEADER}/// <reference types="vite/client" />\n\nexport const SCOPE = "user";\n`,
    });
    expect(reachesWorkersRuntime(packages, join(packages, "alpha/src/http/responses.ts")).map(describeReach)).toEqual([
      "alpha/src/http/responses.ts -> alpha/src/data/leak.ts (carries a triple-slash reference directive)",
    ]);
  });

  it("does not mistake a directive inside a template literal for one the module carries", () => {
    // `@pithy-sh/vite`'s `clientEnvDeclaration.ts` writes a `vite/client` reference into the declaration
    // file it emits. That is text it produces, not ambient types it acquires, and a gate that cannot tell
    // the two apart is a gate somebody turns off.
    const packages = write("emitted-directive", {
      "alpha/src/http/responses.ts": `${HEADER}export { PREAMBLE } from "../data/emit";\n`,
      "alpha/src/data/emit.ts": `${HEADER}export const PREAMBLE = \`/// <reference types="vite/client" />\n\`;\n`,
    });
    expect(reachesWorkersRuntime(packages, join(packages, "alpha/src/http/responses.ts"))).toEqual([]);
  });

  it("follows a directory index and a cross-package specifier", () => {
    // The two forms the old resolver did handle, kept under assertion because widening the candidate
    // list is exactly the edit that quietly drops one of them.
    const packages = write("shapes", {
      "alpha/src/http/responses.ts": `${HEADER}export { Db } from "@pithy-sh/beta/src/data/tables";\n`,
      "beta/src/data/tables/index.ts": SERVER,
    });
    expect(reachesWorkersRuntime(packages, join(packages, "alpha/src/http/responses.ts")).map(describeReach)).toEqual([
      "alpha/src/http/responses.ts -> beta/src/data/tables/index.ts (imports @cloudflare/workers-types)",
    ]);
  });

  it("follows the rest of the emitted-suffix family, and the `.tsx` a component would answer with", () => {
    // `.tsx` had the same hole as `.js` and no producer today — `@pithy-sh/ui-react` writes components,
    // and none of them is reached from a response schema. A branch nothing exercises is a branch nobody
    // finds out is wrong, so it is exercised here rather than left for the commit that first needs it.
    const packages = write("jsx", {
      "alpha/src/http/responses.ts": `${HEADER}export { Panel } from "../ui/panel.jsx";\n`,
      "alpha/src/ui/panel.tsx": `${HEADER}import type { D1Database } from "@cloudflare/workers-types";\nexport const Panel = (d1: D1Database) => d1;\n`,
    });
    expect(reachesWorkersRuntime(packages, join(packages, "alpha/src/http/responses.ts")).map(describeReach)).toEqual([
      "alpha/src/http/responses.ts -> alpha/src/ui/panel.tsx (imports @cloudflare/workers-types)",
    ]);
  });

  it("catches a subpath of the Workers types, and a dynamic import of the module holding it", () => {
    // Two list-shaped holes in one fixture. `link/sender.ts` reaches its optional capabilities through a
    // dynamic import, so the walk has always followed one; the types package has subpaths, and matching
    // only the exact string would be the count-of-spellings mistake at the smallest possible scale.
    const packages = write("subpath", {
      "alpha/src/http/responses.ts": `${HEADER}export async function load() {\n  return import("../link/sender");\n}\n`,
      "alpha/src/link/sender.ts": `${HEADER}import type { D1Database } from "@cloudflare/workers-types/experimental";\nexport type Db = D1Database;\n`,
    });
    expect(reachesWorkersRuntime(packages, join(packages, "alpha/src/http/responses.ts")).map(describeReach)).toEqual([
      "alpha/src/http/responses.ts -> alpha/src/link/sender.ts (imports @cloudflare/workers-types/experimental)",
    ]);
  });

  it("reports the shortest trail, once per fault", () => {
    // Breadth-first, and deduplicated. A module reached two ways is one line, and the line is the route a
    // reader can act on rather than whichever one the queue happened to finish first.
    const packages = write("shortest", {
      "alpha/src/http/responses.ts": `${HEADER}export { Db } from "../data/near";\nexport { Db as Far } from "../data/long";\n`,
      "alpha/src/data/near.ts": `${HEADER}export type { Db } from "../link/sender";\n`,
      "alpha/src/data/long.ts": `${HEADER}export type { Db } from "./hop";\n`,
      "alpha/src/data/hop.ts": `${HEADER}export type { Db } from "../link/sender";\n`,
      "alpha/src/link/sender.ts": SERVER,
    });
    expect(reachesWorkersRuntime(packages, join(packages, "alpha/src/http/responses.ts")).map(describeReach)).toEqual([
      "alpha/src/http/responses.ts -> alpha/src/data/near.ts -> alpha/src/link/sender.ts " +
        "(imports @cloudflare/workers-types)",
    ]);
  });
});
