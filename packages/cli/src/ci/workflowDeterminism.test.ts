// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "rolldown/parseAst";
import { describe, expect, test } from "vitest";
import { sourceFiles } from "./sourceFiles";
import { analyzeDrivers, type DriverSource, type Node } from "./workflowDrivers";

/**
 * **No Workflow driver body reads a clock or a random source outside a step.** (#331)
 *
 * The rule and its argument live in `workflowDrivers.ts`; this is what holds the kit to it.
 *
 * Three things have to be true at once for a gate like this to mean anything, and each is a test below:
 *
 *   1. **The rule finds a violation when there is one.** Fixtures, run through the same analyzer the tree
 *      scan uses, with the defect present and then moved into a step.
 *   2. **It ranges over every shipped Workflow.** The population is discovered from the filesystem and then
 *      *cross-checked against a second, independent enumeration* — the `className` every `WorkflowSpec`
 *      declares — and asserted exactly. A workflow added in any package fails this until somebody looks.
 *   3. **The tree obeys it.** No findings, stated as an empty set rather than a count.
 *
 * The exact-population assertion is the load-bearing one. pithy-sh/pithy#326 finding 4 is a gate that named
 * four things when seven shipped and passed for months by asserting about the four; a floor (`toBeGreaterThan`)
 * would be the same defect spelled differently.
 */

/** `packages/cli/src/ci` → the repository. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * The parser, supplied here rather than imported by the analyzer — see `ParseModule`.
 *
 * Rolldown's, which is oxc: ESTree-shaped and TypeScript-aware. It is the parser `vite` already downloads
 * for this repository's own test runner, so the gate costs no package and no byte that was not here anyway.
 * Declared as a direct devDependency all the same — a parser reached through somebody else's bundler is a
 * build that breaks the day they bump it.
 */
const parseModule = (text: string): Node => parseAst(text, { lang: "ts" }, "source.ts") as unknown as Node;

/** Every shipped `.ts` under `packages/`, repo-relative and POSIX, so a finding names a path a human can open. */
function packageSources(): DriverSource[] {
  return sourceFiles(join(REPO_ROOT, "packages")).map((file) => ({
    path: relative(REPO_ROOT, file.path).split(sep).join("/"),
    text: file.text,
  }));
}

const analysis = analyzeDrivers(packageSources(), parseModule);

/**
 * Every Workflow the kit ships, as `path#ClassName`.
 *
 * **This is a list, and it is meant to be.** Everything else is derived — the analyzer re-reads the tree on
 * every run, so a Workflow added tomorrow is analyzed tomorrow with nothing to remember. But "derived" and
 * "unnoticed" are the same thing unless something says out loud what the derivation currently finds, so this
 * is the tripwire: a new Workflow fails here, and gets added by a human who has read the rule.
 *
 * Note how little of it is under `src/workflows/`. Three of these are not, and a gate that had globbed that
 * directory would have covered eight of eleven and reported itself green.
 */
const SHIPPED_WORKFLOWS = [
  "packages/email/src/workflows/worker.ts#EmailSchedulerWorkflow",
  "packages/email/src/workflows/worker.ts#EmailSendWorkflow",
  "packages/leaderboard/src/rank/worker.entry.ts#RankRefreshWorkflow",
  "packages/media/src/workflows/worker.ts#MediaAudioTranscribeWorkflow",
  "packages/media/src/workflows/worker.ts#MediaDocExtractWorkflow",
  "packages/media/src/workflows/worker.ts#MediaImageToTextWorkflow",
  "packages/media/src/workflows/worker.ts#MediaVideoTranscribeWorkflow",
  "packages/payments/src/workflows/worker.ts#PaymentsReconcileWorkflow",
  "packages/secrets/src/manager/worker.ts#AtRestKeyRotationWorkflow",
  "packages/secrets/src/manager/worker.ts#SecretsWriteWorkflow",
  "packages/storage/src/workflows/worker.ts#StorageSweepWorkflow",
  "packages/support/src/workflows/worker.ts#SupportClassifyWorkflow",
  "packages/testers/src/workflows/worker.ts#TestersDailyWorkflow",
  "packages/vector/src/workflows/worker.ts#VectorReprocessWorkflow",
];

/**
 * The delegates: functions a Workflow class hands its step runner to.
 *
 * They are driver bodies too, and they are where the defect actually lived — `reconcilePayments` is a pure
 * function over injected deps, which is what made it testable and also what made it easy to forget that it
 * re-executes from the top on every resume.
 */
const SHIPPED_DELEGATES = [
  // #338. Not a capability's driver but the classifier every driver's steps now pass through, which is
  // exactly why it belongs in this population: a clock or a random source read here would be read by all
  // of them at once.
  "packages/core/src/workflow/faults.ts#classifiedSteps",
  "packages/email/src/workflows/sendBatch.ts#runSendBatch",
  "packages/payments/src/workflows/reconcile.ts#reconcilePayments",
  "packages/secrets/src/manager/rotationWorkflow.ts#runRotationWorkflow",
  "packages/secrets/src/rotation/atRestKeyRotation.ts#runAtRestKeyRotation",
  "packages/testers/src/workflows/pass.ts#runDurableDailyPass",
  "packages/vector/src/workflows/reprocess.ts#reprocessIndex",
];

describe("the population this gate ranges over", () => {
  test("is the whole of it — every `WorkflowEntrypoint` subclass in the tree", () => {
    expect(analysis.entrypoints).toEqual(SHIPPED_WORKFLOWS);
  });

  test("and every function a Workflow hands its step runner to", () => {
    const delegates = analysis.drivers
      .filter((driver) => driver.kind === "delegate")
      .map((driver) => `${driver.file}#${driver.name}`);
    expect(delegates).toEqual(SHIPPED_DELEGATES);
  });

  test("agrees with the specs, which enumerate the same workflows for an entirely different reason", () => {
    // The CLI writes `className` into a host worker's `workflows` array. It is derived from the capability's
    // own spec map, never from this walk — so a name in one and not the other is a real disagreement rather
    // than a restatement. Email, secrets and leaderboard host their own workflows and declare no spec.
    const discovered = new Set(analysis.entrypoints.map((entry) => entry.split("#")[1]));
    for (const className of analysis.declaredClassNames) expect([...discovered]).toContain(className);
    expect(analysis.declaredClassNames.length).toBeGreaterThan(0);
  });

  test("was read from real files, not from an empty walk", () => {
    // A tripwire whose input silently became empty passes every assertion about findings.
    expect(analysis.parsed).toBeGreaterThan(500);
    expect(analysis.drivers).toHaveLength(SHIPPED_WORKFLOWS.length + SHIPPED_DELEGATES.length);
  });
});

describe("the rule, proved against fixtures before it is trusted against the tree", () => {
  /** Analyze one module's text as though it were a file in the tree. */
  function analyze(text: string) {
    return analyzeDrivers([{ path: "fixture.ts", text }], parseModule);
  }

  const CLASS_WITH_BODY_CLOCK = `
    class FixtureWorkflow extends WorkflowEntrypoint<Env, P> {
      override async run(event: WorkflowEvent<P>, step: WorkflowStep): Promise<void> {
        const now = new Date();
        await step.do("work", async () => { await write(now); });
      }
    }
  `;

  const CLASS_WITH_JOURNALED_CLOCK = `
    class FixtureWorkflow extends WorkflowEntrypoint<Env, P> {
      override async run(event: WorkflowEvent<P>, step: WorkflowStep): Promise<void> {
        const nowMs: number = await step.do("start", async () => Date.now());
        const now = new Date(nowMs);
        await step.do("work", async () => { await write(now); });
      }
    }
  `;

  test("a clock read in a driver body is named, with its line and the expression that did it", () => {
    const { findings } = analyze(CLASS_WITH_BODY_CLOCK);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      name: "FixtureWorkflow.run",
      kind: "entrypoint",
      expression: "new Date()",
      via: "FixtureWorkflow.run",
      line: 4,
    });
  });

  test("the same read inside a step is not — which is the whole distinction the rule draws", () => {
    expect(analyze(CLASS_WITH_JOURNALED_CLOCK).findings).toEqual([]);
  });

  test("a thunk handed to a step is a definition, not an evaluation", () => {
    // `now: () => new Date()` is the correct pattern, and a gate that refused it would be unusable.
    const { findings } = analyze(`
      class FixtureWorkflow extends WorkflowEntrypoint<Env, P> {
        override async run(event: WorkflowEvent<P>, step: WorkflowStep): Promise<void> {
          const deps = { now: () => new Date(), newId: () => crypto.randomUUID() };
          await step.do("work", () => run(deps));
        }
      }
    `);
    expect(findings).toEqual([]);
  });

  test("a source reached through a module-local helper is named at the helper, not missed at the call", () => {
    // Email's clock was exactly this: one `await buildSendDeps(this.env)` in the body, and the read a frame
    // down. A walk that stopped at the call site would have reported this file clean.
    const { findings } = analyze(`
      function buildDeps(env: Env) {
        return { db: database(env.DB), now: new Date() };
      }
      class FixtureWorkflow extends WorkflowEntrypoint<Env, P> {
        override async run(event: WorkflowEvent<P>, step: WorkflowStep): Promise<void> {
          const deps = buildDeps(this.env);
          await step.do("work", () => run(deps));
        }
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ expression: "new Date()", via: "buildDeps", line: 3 });
  });

  test("an injected clock is a source too, however it is spelled", () => {
    // The #331 instance. `deps.now()` names no global, so nothing about `Date` could have caught it — and
    // that is the argument for a rule about arity rather than about names.
    const { findings } = analyze(`
      export async function runPass(deps: PassDeps, step: FixtureStep): Promise<void> {
        const now = deps.now();
        await step.do("work", async () => write(now));
      }
      export interface FixtureStep {
        do<T>(name: string, callback: () => Promise<T>): Promise<T>;
      }
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ name: "runPass", kind: "delegate", expression: "deps.now()" });
  });

  test("a delegate is found by the shape of its step runner, not by what the interface is called", () => {
    // `ReconcileStep`, `ReprocessStep` and `StepRunner` are three names for one seam. A fourth is found the
    // same way: one member, `do`, taking a name and a callback.
    const { drivers } = analyze(`
      export interface WhateverTheyCallIt {
        do<T>(name: string, callback: () => Promise<T>): Promise<T>;
      }
      export async function runIt(deps: D, step: WhateverTheyCallIt): Promise<void> {
        await step.do("work", async () => {});
      }
    `);
    expect(drivers).toEqual([{ file: "fixture.ts", name: "runIt", kind: "delegate" }]);
  });

  test("an entropy source is caught by the same rule as a clock, with nothing added to catch it", () => {
    const { findings } = analyze(`
      class FixtureWorkflow extends WorkflowEntrypoint<Env, P> {
        override async run(event: WorkflowEvent<P>, step: WorkflowStep): Promise<void> {
          const id = crypto.randomUUID();
          const jitter = Math.random();
          const at = performance.now();
          await step.do("work", async () => write(id, jitter, at));
        }
      }
    `);
    expect(findings.map((finding) => finding.expression)).toEqual([
      "crypto.randomUUID()",
      "Math.random()",
      "performance.now()",
    ]);
  });
});

/**
 * Sites the sweep found and this repository has not fixed yet, each with an issue.
 *
 * **The list is empty, and it stays a list.** It held three — pithy-sh/pithy#327, #328 and #329 — and
 * every one is closed. An empty array is not a formality here: this assertion is `toEqual`, so an empty
 * expectation is the strongest form the gate has ever been in. Any driver body that evaluates a source
 * fails on the line below, named with its file, its driver and its expression.
 *
 * **They are listed, not excused**, and that is why the list could empty. A gate that had skipped them
 * instead would be the thing this file exists to prevent — a rule narrowed until nothing violates it.
 * The list is exact in both directions: a new finding fails, and a listed one that gets fixed fails too,
 * so an entry cannot outlive its defect.
 *
 * **A value that must be fresh per attempt is not an exception to the rule, and none is declared here.**
 * Three drivers need one — email's `updatedAt` heartbeat, testers' nudge enqueue, payments' `finishedAt`
 * — and every one of them is spelled as a thunk that a step calls, which the rule already permits
 * because a function body is not evaluated where it is written. If a future case genuinely cannot be
 * spelled that way, it belongs *here*, named and argued, rather than smuggled past the walk.
 */
const KNOWN: readonly string[] = [];

describe("the kit", () => {
  test("evaluates no source in any Workflow driver body", () => {
    // The exact set, not a count and not a subset: a finding here prints the file, the driver, the line
    // and the expression, which is the whole of what somebody needs to fix it. Holding the list exactly
    // means a new violation fails and a fixed one fails too, so `KNOWN` cannot rot into a mute button.
    expect(
      analysis.findings
        .map(
          (finding) => `${finding.file}:${finding.line} ${finding.name} (via ${finding.via}) — ${finding.expression}`,
        )
        .sort(),
    ).toEqual([...KNOWN].sort());
  });
});
