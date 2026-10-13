// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import type { Caller, WorkerDir } from "@pithy-sh/core/src/cli/command";
import { InputRequiredError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import { type AddPlan, addAction, addPlan, withAddFix } from "./addCommand";
import type { AddFacts } from "./kitAddFacts";

/**
 * **A capability's prerequisites are declared in its manifest, and every command reads them from there.**
 *
 * `peerCapabilities` has been in `pithy.manifest.json` since the contract landed, and `createBackend`
 * has always refused to assemble without them — `Capability "auth" requires the "secrets" capability,
 * which is not composed.` What was missing was anything between the two: `pithy add auth` wrote the
 * registration, said `Done.`, and left a Worker that could not start (#273). `pithy doctor` said the
 * project was healthy, because it checked bindings, config keys and migrations, and nobody had asked it
 * this question.
 *
 * So this module is the one place that answers it, for both commands. `pithy add` resolves the closure
 * before it wires anything; `pithy doctor` reports a composed capability whose peer is absent and fails
 * its exit. Neither hand-lists a capability's prerequisites, because hand-listing them is how the next
 * capability's get missed — `payments`, `support`, `storage`, `media` and `turnstile` all declare
 * `secrets`, and `testers` declares `email`.
 *
 * The manifest, and not the composed instance's `dependsOn`: the two mirror each other by test in each
 * capability's package, and the manifest is the half that is readable before a capability is composed —
 * which is exactly when `pithy add` has to decide.
 */

/** A composed capability whose declared prerequisite is not composed beside it. */
export const MissingPrerequisite = z
  .object({
    capability: z.string().describe("The composed capability that declares the prerequisite, by manifest name."),
    requires: z
      .string()
      .describe(
        "The capability it declares as a peer and this Worker does not compose. Boot refuses on exactly this pair.",
      ),
  })
  .describe("A composed capability whose manifest declares a peer the Worker's config does not register.");
export type MissingPrerequisite = z.infer<typeof MissingPrerequisite>;

/**
 * Every prerequisite a Worker's composed set declares and does not satisfy — `pithy doctor`'s check.
 *
 * Scoped to the composed set on purpose. Manifests resolve once from the project root, so they describe
 * every capability installed *anywhere* in the project; only this Worker's `pithy.config.ts` says what
 * this Worker is made of. An `audit` another Worker composes must not make this one unhealthy.
 *
 * Reported in the order a manifest declares its peers, so the sentence matches the file.
 */
export function missingPrerequisites(
  manifests: readonly CapabilityManifest[],
  composed: ReadonlySet<string>,
): MissingPrerequisite[] {
  const missing: MissingPrerequisite[] = [];
  for (const manifest of manifests) {
    if (!composed.has(manifest.name)) continue;
    for (const peer of manifest.peerCapabilities) {
      if (!composed.has(peer)) missing.push({ capability: manifest.name, requires: peer });
    }
  }
  return missing;
}

/** `a`, `a and b`, `a, b and c` — for a sentence, never for a command line. */
function andList(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** What {@link prerequisiteRefusal} names: the capability asked for, the Worker, and what it lacks. */
export interface PrerequisiteRefusalOptions {
  /** The capability the adopter asked for. */
  capability: string;
  /** The Worker it was to be wired into — the one whose config lacks the peers — by `apps/` directory. */
  worker: WorkerDir;
  /** The missing prerequisites, deepest first, as `prerequisiteClosure` ordered them. */
  missing: readonly string[];
  /** Each capability's manifest facts, so every command carries the options it needs (`addCommand.ts`). */
  factsFor: (name: string) => AddFacts | undefined;
  /** What the Worker composes already. */
  composed: ReadonlySet<string>;
  /**
   * The caller's own run (#711): every flag and `--set` it was given, and every option its Worker's config answers,
   * which the command it names carries — and the mode (`--dry-run`, `--json`) each step on the way carries.
   */
  caller: Caller<"add">;
}

/** The one-command answer: the capability, on that Worker, with its prerequisites and the run's own flags. */
function oneCommand(options: PrerequisiteRefusalOptions): AddPlan {
  const { capability, worker, factsFor, composed, caller } = options;
  return addPlan({ capability, workers: [worker], factsFor, composed, caller });
}

/**
 * The manual sequence, deepest first: each prerequisite's own add, on the Worker, with what composed before it.
 * Every step a plan of its own, so a prerequisite with an option to decide says so.
 */
function sequence(options: PrerequisiteRefusalOptions): string {
  const { worker, missing, factsFor, caller } = options;
  const composed = new Set(options.composed);
  const steps: string[] = [];
  for (const name of missing) {
    steps.push(addAction(addPlan({ capability: name, workers: [worker], factsFor, composed, caller }), (add) => add));
    composed.add(name);
  }
  return steps.length > 1 ? `${steps.slice(0, -1).join(", ")}, then ${steps.at(-1)}` : steps.join("");
}

/** The two lines both refusals say: what is missing, and the commands that compose it, in order. */
function prerequisiteLines(options: PrerequisiteRefusalOptions): { message: string; action: string; detail: string } {
  const { capability, worker, missing } = options;
  // Every command names the Worker (#711), and every one is built from the manifests, so an option the kit
  // cannot default is named as the choice it is rather than left for the command to be refused over.
  return {
    message: `${capability} requires ${andList(missing)}, which ${worker} does not compose.`,
    action: addAction(
      oneCommand(options),
      (add) => `Run ${add}, or compose ${missing.length === 1 ? "it" : "them"} first: ${sequence(options)}.`,
    ),
    detail: `${capability}'s manifest declares peerCapabilities ${JSON.stringify(missing)}; createBackend refuses to assemble without them.`,
  };
}

/**
 * The refusal a person who was asked, and declined, takes.
 *
 * **It names the commands, in dependency order.** A refusal that says only "auth requires secrets" makes
 * the adopter guess the order, and guessing wrong reproduces the defect one capability along. The flag
 * comes first because it is the one-command answer; the manual sequence is there for whoever wants to
 * decide each one, which is the honest half of composing something nobody asked for.
 */
export function prerequisiteRefusal(options: PrerequisiteRefusalOptions): ValidationError {
  return new ValidationError(prerequisiteLines(options));
}

/**
 * The same words for a run that could not ask: `input/required`, naming `--with-prerequisites` (#697).
 * Kept apart from {@link prerequisiteRefusal} because "nobody was asked" and "somebody said no" are
 * different facts, and an agent reading the code should be able to tell which one it got.
 *
 * Its `fix` is the one-command answer the action leads with, from the same plan (#711) — when that command
 * runs as written, with nothing in it left to choose.
 */
export function prerequisiteRequired(options: PrerequisiteRefusalOptions): InputRequiredError {
  return withAddFix(
    new InputRequiredError({ ...prerequisiteLines(options), flag: "--with-prerequisites" }),
    oneCommand(options),
  );
}
