// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "rolldown/parseAst";
import { describe, expect, test } from "vitest";
import { sourceFiles } from "./sourceFiles";
import { analyseDrivers, type DriverSource, type Node } from "./workflowDrivers";

/**
 * **Every module in this kit that extends `WorkflowEntrypoint` has a default export.** (#426)
 *
 * The rule and its argument live in `workflowDrivers.ts`; this is what holds the kit to it.
 *
 * A Workflow host's entry imports `cloudflare:workers`, and whether that import resolves is decided by the
 * module *format* wrangler infers — which it infers from one thing, the presence of a default export. Without
 * one the build warns, falls back to service-worker format, and then refuses the entry:
 *
 *     ▲ [WARNING] The entrypoint packages/support/src/workflows/worker.ts has exports like an ES Module,
 *               but hasn't defined a default export like a module worker normally would. Building the
 *               worker using "service-worker" format...
 *     ✘ [ERROR] Unexpected external import of "cloudflare:workers" and "cloudflare:workflows".
 *
 * `pithy dev` builds each worker in the set separately and carries on past one that fails, so the host
 * simply is not there and the Workflows it hosts never run. Nothing else says so.
 *
 * **Four of the seven satisfied the rule by accident.** `email`, `payments`, `storage` and `testers` each
 * fire their Workflow on a cron, so each carries `export default { async scheduled(…) }` — written for the
 * cron, and making the module an ES module as a side effect nobody named. `support`, `media` and `vector`
 * have no cron, so nothing prompted their authors to write one, and all three shipped unbuildable. That is
 * the defect shape this repository keeps meeting: a rule satisfied at the call site by whoever happened to
 * need something else.
 *
 * So the population is **derived, never listed** — `analyseDrivers` re-reads the tree on every run, and a
 * host added tomorrow is judged tomorrow with nothing to remember. Its exact membership is pinned once, in
 * `workflowDeterminism.test.ts`'s `SHIPPED_WORKFLOWS`, off this same walk; restating it here would be a
 * second list to forget, which is the thing being fixed rather than a way of fixing it.
 */

/** `packages/cli/src/ci` → the repository. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/** The parser, supplied rather than imported — see `ParseModule`. Rolldown's, which is oxc. */
const parseModule = (text: string): Node => parseAst(text, { lang: "ts" }, "source.ts") as unknown as Node;

/** Every shipped `.ts` under `packages/`, repo-relative and POSIX, so a finding names a path a human can open. */
function packageSources(): DriverSource[] {
  return sourceFiles(join(REPO_ROOT, "packages")).map((file) => ({
    path: relative(REPO_ROOT, file.path).split(sep).join("/"),
    text: file.text,
  }));
}

const analysis = analyseDrivers(packageSources(), parseModule);

describe("the rule, proved against fixtures before it is trusted against the tree", () => {
  /** Analyse one module's text as though it were a file in the tree. */
  function analyse(text: string) {
    return analyseDrivers([{ path: "fixture.ts", text }], parseModule);
  }

  const CLASSES_ONLY = `
    import { WorkflowEntrypoint } from "cloudflare:workers";
    export class FixtureWorkflow extends WorkflowEntrypoint<Env, P> {
      override async run(event: WorkflowEvent<P>, step: WorkflowStep): Promise<void> {}
    }
  `;

  test("a Workflow module with no default export is named, with the classes it hosts", () => {
    expect(analyse(CLASSES_ONLY).hosts).toEqual([
      { file: "fixture.ts", classes: ["FixtureWorkflow"], defaultExport: false },
    ]);
  });

  test("the same module with a default export is not — which is the whole distinction", () => {
    const { hosts } = analyse(`${CLASSES_ONLY}\nexport default { async fetch() { return new Response(); } };`);
    expect(hosts).toEqual([{ file: "fixture.ts", classes: ["FixtureWorkflow"], defaultExport: true }]);
  });

  test("a renamed export counts — the build asks for a default binding, not for a literal", () => {
    // `export { entry as default }` and `export default entry` are the same module shape to esbuild, so a
    // gate that matched the second spelling alone would refuse a module that builds perfectly well.
    const { hosts } = analyse(`${CLASSES_ONLY}\nconst entry = { fetch() {} };\nexport { entry as default };`);
    expect(hosts[0]?.defaultExport).toBe(true);
  });

  test("a re-exported default counts too, for the same reason", () => {
    const { hosts } = analyse(`${CLASSES_ONLY}\nexport { default } from "./entry";`);
    expect(hosts[0]?.defaultExport).toBe(true);
  });

  test("the words in a comment are not an export", () => {
    // Structural, not textual. This file itself quotes `export default { ... }` in its own prose.
    const { hosts } = analyse(`${CLASSES_ONLY}\n// try adding \`export default { ... }\` in your entry-point`);
    expect(hosts[0]?.defaultExport).toBe(false);
  });

  test("a module that hosts no Workflow is not in the population at all", () => {
    // The rule is about Workflow hosts. Every other module in the kit is a library module with no default
    // export and no business having one, and a gate that asked them the same question would be unusable.
    expect(analyse(`export const helper = () => 1;`).hosts).toEqual([]);
  });

  test("both classes of a two-Workflow module are reported against the one file", () => {
    // The unit is the module: `main` names a file, and one default export serves every class in it.
    const { hosts } = analyse(`
      export class OneWorkflow extends WorkflowEntrypoint<Env, P> {}
      export class TwoWorkflow extends WorkflowEntrypoint<Env, P> {}
    `);
    expect(hosts).toEqual([{ file: "fixture.ts", classes: ["OneWorkflow", "TwoWorkflow"], defaultExport: false }]);
  });
});

describe("the population this gate ranges over", () => {
  test("was read from real files, not from an empty walk", () => {
    // A tripwire whose input silently became empty passes every assertion about findings.
    expect(analysis.parsed).toBeGreaterThan(500);
    expect(analysis.hosts.length).toBeGreaterThan(0);
  });

  test("is every module holding a Workflow class, and nothing is dropped between the two views", () => {
    // `entrypoints` is the flat `path#ClassName` set the determinism gate pins exactly. `hosts` regroups it
    // by file, so the two must agree — a host missing from one view is a discovery bug in this walk rather
    // than a defect in the tree, and it would make the gate below quietly narrower than the rule.
    const byFile = new Map<string, string[]>();
    for (const entry of analysis.entrypoints) {
      const [file, className] = entry.split("#");
      if (file === undefined || className === undefined) throw new Error(`unparseable entrypoint: ${entry}`);
      byFile.set(file, [...(byFile.get(file) ?? []), className]);
    }
    expect(analysis.hosts.map((host) => ({ file: host.file, classes: host.classes }))).toEqual(
      [...byFile.entries()]
        .map(([file, classes]) => ({ file, classes: classes.sort() }))
        .sort((a, b) => a.file.localeCompare(b.file)),
    );
  });
});

/**
 * Modules the sweep found and this repository has not fixed yet, each with an issue.
 *
 * **The list is empty, and it stays a list.** It held three — `support`, `media` and `vector` — and all three
 * are fixed in the commit that added this file. An empty array is not a formality: the assertion is
 * `toEqual`, so a new host with no default export fails, and a listed one that gets fixed fails too. An
 * entry cannot outlive its defect, and the list cannot rot into a mute button.
 */
const KNOWN: readonly string[] = [];

describe("the kit", () => {
  test("ships no Workflow host that the build would read as a service worker", () => {
    expect(
      analysis.hosts
        .filter((host) => !host.defaultExport)
        .map((host) => `${host.file} — hosts ${host.classes.join(", ")} with no default export`)
        .sort(),
    ).toEqual([...KNOWN].sort());
  });
});
