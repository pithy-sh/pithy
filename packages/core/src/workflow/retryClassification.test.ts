// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";

// `import.meta.glob` is a vite/vitest feature; declare it so plain `tsc` typecheck accepts it.
declare global {
  interface ImportMeta {
    glob(patterns: string[], options: { eager: true; query: "?raw"; import: "default" }): Record<string, string>;
  }
}

/**
 * **Every Workflow entrypoint hands its step runner to `classifiedSteps`, and uses nothing else.**
 *
 * The rule and its argument live in `faults.ts`. This is what holds the kit to it, and it is written as
 * a statement about what must be true rather than a list of the Workflows that need fixing: a Workflow
 * added tomorrow, in any package, under any directory, fails this until somebody classifies it.
 *
 * The raw `step` is the whole subject. A `WorkflowEntrypoint` receives it from the platform, and every
 * durable body below — `reconcilePayments`, `runSendBatch`, `runAtRestKeyRotation` — receives whatever
 * the entrypoint passes down. So there is exactly one place per Workflow where the classification can be
 * applied and exactly one way to bypass it, which is to use the parameter for anything except handing it
 * to the classifier. That is what is checked: not "does this file mention retries" but "can an
 * unclassified fault still reach the platform through this parameter".
 *
 * ## Three things have to be true at once, and each is a test below
 *
 *   1. **The check finds a violation when there is one.** Fixtures, through the same analyzer the tree
 *      scan uses, with the raw step used and then handed over.
 *   2. **It ranges over every shipped Workflow.** The population is discovered from the filesystem and
 *      asserted exactly against one hand-written list. The list is not derived from the code it
 *      polices; a new entrypoint is not on it, and fails.
 *   3. **The tree obeys it.** Stated as an empty set of findings rather than a count.
 *
 * There was a second list. `UNCLASSIFIED` held the seven Workflows #338 left on the platform default,
 * asserted to be *still* unclassified so it could only ever shrink; pithy-sh/pithy#348 emptied it and
 * removed it. There is now one list and one rule, and the only way onto the list is to be classified.
 */

/**
 * Every Workflow the kit ships, as repo-relative paths. All of them classify their steps.
 *
 * A list, deliberately. Everything else here is derived from the tree on every run, but "derived" and
 * "unnoticed" are the same thing unless something says out loud what the derivation currently finds.
 */
const CLASSIFIED = [
  "packages/email/src/workflows/worker.ts",
  "packages/leaderboard/src/rank/worker.entry.ts",
  "packages/media/src/workflows/worker.ts",
  "packages/payments/src/workflows/worker.ts",
  "packages/secrets/src/manager/worker.ts",
  "packages/storage/src/workflows/worker.ts",
  "packages/support/src/workflows/worker.ts",
  "packages/testers/src/workflows/worker.ts",
  "packages/vector/src/workflows/worker.ts",
];

/** One source file the scan reads. */
interface Source {
  /** Repo-relative, POSIX, so a finding names a path a human can open. */
  path: string;
  text: string;
}

/**
 * Every shipped `.ts` in every package, read raw — tests excluded, because a test is not a Workflow.
 *
 * Through `import.meta.glob` rather than a filesystem walk: `@pithy-sh/core` is Worker-only and its
 * `tsconfig` has no Node types at all, so a gate that lives beside the classifier cannot `readdir`. The
 * glob is resolved by vite at load, and the population assertion below is what proves it matched.
 */
const sources: Source[] = Object.entries(
  import.meta.glob(["../../../*/src/**/*.ts", "!../../../*/src/**/*.test.ts"], {
    eager: true,
    query: "?raw",
    import: "default",
  }),
).map(([path, text]) => ({ path: path.replace(/^\.\.\/\.\.\/\.\.\//, "packages/"), text }));

/**
 * The code, with comments removed.
 *
 * Prose is not policy: this kit's Workflow files discuss steps and retries at length, and a scan that
 * read a paragraph as a use of the parameter would report every one of them. A `//` preceded by `:` is
 * left alone so a URL in a string survives.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** One Workflow entrypoint's `run`, and the name it gave its step parameter. */
interface Entrypoint {
  /** The whole signature, so the scan can blank it before looking for uses. */
  signature: string;
  /** The second parameter's identifier — `step` by convention, but read rather than assumed. */
  stepParam: string;
}

/** Every `run(event, step)` signature in a file, with the step parameter's real name. */
function entrypointRuns(source: string): Entrypoint[] {
  const runs: Entrypoint[] = [];
  for (const match of source.matchAll(/\brun\s*\(([^)]*)\)/g)) {
    const params = (match[1] ?? "").split(",");
    const second = params[1];
    if (second === undefined) continue;
    const name = second.trim().split(":")[0]?.trim();
    if (name && /^[A-Za-z_$][\w$]*$/.test(name)) runs.push({ signature: match[0], stepParam: name });
  }
  return runs;
}

/**
 * Every use of a raw step parameter that is not its hand-off to `classifiedSteps`.
 *
 * This is the finding. A use may be a `.do(` on it, a pass-through to a body function, or anything else
 * a next author invents: the rule does not enumerate the ways to misuse the parameter, it says the
 * parameter has exactly one legitimate destination.
 */
function rawStepUses(text: string): string[] {
  let source = code(text);
  if (!/extends\s+WorkflowEntrypoint/.test(source)) return [];

  const runs = entrypointRuns(source);
  // Blank the signatures: the declaration is not a use, and it names the identifier being looked for.
  for (const run of runs) source = source.split(run.signature).join(" ");

  const uses: string[] = [];
  for (const name of new Set(runs.map((run) => run.stepParam))) {
    const identifier = new RegExp(`\\b${name}\\b`, "g");
    for (const match of source.matchAll(identifier)) {
      const before = source.slice(Math.max(0, match.index - 40), match.index);
      if (/classifiedSteps\(\s*$/.test(before)) continue;
      const line = source.slice(match.index, source.indexOf("\n", match.index) + 1 || undefined).trim();
      uses.push(`${name}: ${line.slice(0, 80)}`);
    }
  }
  return uses;
}

/** Whether a file's steps are classified: the classifier is imported, and no raw use survives. */
function isClassified(text: string): boolean {
  return /classifiedSteps/.test(code(text)) && rawStepUses(text).length === 0;
}

const shipped = sources;
const entrypoints = shipped.filter((file) => /extends\s+WorkflowEntrypoint/.test(code(file.text)));

describe("the check itself can fail", () => {
  const classified = `
    import { NonRetryableError } from "cloudflare:workflows";
    import { classifiedSteps } from "@pithy-sh/core/src/workflow/faults";
    export class W extends WorkflowEntrypoint<E, P> {
      override async run(event: WorkflowEvent<P>, step: WorkflowStep): Promise<void> {
        const steps = classifiedSteps(step, policy, NonRetryableError);
        await steps.do("work", async () => undefined);
      }
    }`;

  test("a raw step.do is a finding", () => {
    const planted = classified.replace('await steps.do("work"', 'await step.do("work"');
    expect(rawStepUses(planted)).not.toEqual([]);
    expect(isClassified(planted)).toBe(false);
  });

  test("a raw step passed to a body function is a finding — the rule is not about `.do`", () => {
    const planted = classified.replace('await steps.do("work", async () => undefined);', "await runBody(deps, step);");
    expect(rawStepUses(planted)).not.toEqual([]);
  });

  test("a Workflow that classifies nothing at all is a finding", () => {
    const planted = `
      export class W extends WorkflowEntrypoint<E, P> {
        override async run(event: WorkflowEvent<P>, step: WorkflowStep): Promise<void> {
          await step.do("work", async () => undefined);
        }
      }`;
    expect(isClassified(planted)).toBe(false);
  });

  test("a step parameter under another name is still the subject", () => {
    const planted = `
      export class W extends WorkflowEntrypoint<E, P> {
        override async run(event: WorkflowEvent<P>, durable: WorkflowStep): Promise<void> {
          await durable.do("work", async () => undefined);
        }
      }`;
    expect(rawStepUses(planted)).not.toEqual([]);
  });

  test("prose about steps is not a use", () => {
    const documented = classified.replace(
      "export class W",
      "/** The step retries; a step that inherits the default has not decided. */\nexport class W",
    );
    expect(rawStepUses(documented)).toEqual([]);
  });

  test("the classified fixture passes", () => {
    expect(rawStepUses(classified)).toEqual([]);
    expect(isClassified(classified)).toBe(true);
  });
});

describe("every Workflow the kit ships is accounted for", () => {
  test("the scan read the tree", () => {
    // A gate over an empty population is not a gate.
    expect(shipped.length).toBeGreaterThan(200);
  });

  test("the entrypoints found are exactly the list", () => {
    expect(entrypoints.map((file) => file.path).sort()).toEqual([...CLASSIFIED].sort());
  });

  test("every Workflow hands its step to the classifier and uses it nowhere else", () => {
    const findings = entrypoints.flatMap((file) => rawStepUses(file.text).map((use) => `${file.path} — ${use}`));
    expect(findings).toEqual([]);
  });

  test("every Workflow on the list actually classifies — the import, not only the absence of a raw use", () => {
    const unclassified = entrypoints.filter((file) => !isClassified(file.text));
    expect(unclassified.map((file) => file.path)).toEqual([]);
  });
});
