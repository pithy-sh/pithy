// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { pithyCommand } from "@pithy-sh/core/src/cli/command";
import { z } from "zod";
import { provisionFixCommand } from "../provision/provisionFix";

/**
 * **What a successful run leaves required, as data (#697).**
 *
 * A human reads `Run pithy migrate --env staging.` under a deploy and runs it. An agent reads the `--json`
 * line, and the line said nothing — so it either went looking in the docs or did not go at all. `next` is the
 * follow-up said as a command: `[{ command, why }]`, in the order to run them.
 *
 * **Only when the run knows the step is required, and absent otherwise — never `[]`.** A suggestion an agent
 * has to judge is a suggestion it will either ignore or follow when it should not, so every `next` an agent
 * sees is one it should act on. Each producer below is one command's condition, held to it both ways by
 * `nextSteps.test.ts`: the fact that makes the step required produces it, and every fact short of that —
 * a count nobody took, a dry run, a run that failed — produces no key. {@link NextKey} refuses an empty list,
 * so no published payload can carry one, and `contract/nextKeys.test.ts` holds every payload to that schema.
 *
 * **A step is a whole command, run as written.** Most are `pithy …`, which `ci/actionLines.test.ts` reads out
 * of every `command:` literal and holds to a real command path and its declared flags. Two are the project's
 * package manager, because the follow-up is an install or the project's own CLI rather than this one.
 */

/** One follow-up a run left required. */
export const NextStep = z
  .object({
    command: z.string().min(1).describe("The command to run next, whole, as typed at a shell."),
    why: z.string().min(1).describe("Why it is required, in one sentence."),
  })
  .describe("One follow-up this run left required.");
export type NextStep = z.infer<typeof NextStep>;

/** The `next` key every payload that can carry one declares. Never an empty list. */
export const NextKey = z
  .array(NextStep)
  .min(1)
  .optional()
  .describe("Follow-ups this run left required, in the order to run them. Absent when there are none, never empty.");

/**
 * **`offers` is the optional sibling of `next` (#757).** A follow-up the run found worth putting to the person
 * and did not require, in the same `{ command, why }` shape: an agent asks before it runs one, and acts on a
 * `next` without asking. Two keys rather than one, because a list an agent must judge item by item is the
 * thing `next` exists to never be. Absent when there are none, never empty, never on a dry run or a failed
 * run. `contract/offerKeys.test.ts` holds every payload to this schema.
 */
export const OffersKey = z
  .array(NextStep)
  .min(1)
  .optional()
  .describe(
    "Follow-ups worth putting to the person, which this run did not require. Ask before running one. Absent when there are none, never empty.",
  );

/** `steps`, or no key at all when there are none: `formatJsonLine` drops an `undefined` member. */
export function nextOrAbsent(steps: readonly NextStep[]): NextStep[] | undefined {
  return steps.length === 0 ? undefined : [...steps];
}

/** `1 migration`, `3 migrations`. */
function migrations(count: number): string {
  return count === 1 ? "1 migration" : `${count} migrations`;
}

/** `is` or `are`, for a count. */
function be(count: number): string {
  return count === 1 ? "is" : "are";
}

/** `a`, `a and b`, `a, b and c`. */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The step that applies `env`'s pending migrations. */
function migrateStep(env: string, why: string): NextStep {
  return { command: pithyCommand("migrate", { flags: { "--env": env } }), why };
}

/**
 * `pithy deploy`: the environment's schema is behind the code that just shipped. Deploy never migrates, and
 * a count it established — `partial` counts only what answered, so it never over-reports — is the condition.
 * A bare deploy counts nothing, and a failed one has its own failure to report first.
 */
export function deployNext(facts: {
  env: string | undefined;
  pending: number | undefined;
  failed: boolean;
}): NextStep[] | undefined {
  const { env, pending } = facts;
  if (facts.failed || env === undefined || pending === undefined || pending === 0) return undefined;
  return [migrateStep(env, `${migrations(pending)} ${be(pending)} not applied to ${env}. Deploy does not migrate.`)];
}

/**
 * `pithy provision`: Workers this environment names that no deploy has uploaded. Provisioning names each
 * script and creates what it binds, and the deploy is what makes it answer. `undefined` is an account
 * nobody could ask, which is not an absence.
 */
export function provisionNext(facts: {
  env: string;
  undeployed: readonly string[] | undefined;
}): NextStep[] | undefined {
  const undeployed = facts.undeployed ?? [];
  if (undeployed.length === 0) return undefined;
  return [
    {
      command: pithyCommand("deploy", { flags: { "--env": facts.env } }),
      why: `${listed(undeployed)} ${be(undeployed.length)} not deployed in ${facts.env}.`,
    },
  ];
}

/**
 * `pithy add`: what the capability left an environment that was ready before it.
 *
 * - **`unprovisioned`** — environments every binding of which had a resource before the add, and some of
 *   which do not now. Deploy refuses such a stanza, and provisioning both creates the resources and migrates,
 *   so it replaces the migrate step for that environment rather than joining it. **A production environment
 *   gets no step**: its provision needs a person's `--confirm` phrase on top of `--yes` and ends
 *   `core/person_required` without it, and a step is run as written. `provisionFixCommand` decides it, the
 *   same answer `pithy doctor` and the refusal's `fix` give.
 * - **`pending`** — each provisioned environment's pending count, read from its ledger. The ledger is the
 *   environment's whole, so `why` says how many are not applied and claims none of them for the capability.
 *   The add migrates `dev` and nothing else, and `pithy migrate` needs no phrase, production included.
 */
export function addNext(facts: {
  capability: string;
  unprovisioned: readonly string[];
  pending: readonly { env: string; pending: number }[];
  productionEnvironments?: readonly string[];
}): NextStep[] | undefined {
  const steps: NextStep[] = [];
  for (const env of facts.unprovisioned) {
    const command = provisionFixCommand(env, facts.productionEnvironments);
    if (command === null) continue;
    steps.push({
      command,
      why: `${facts.capability} added bindings ${env} has no resources for, so deploy refuses it. Provisioning creates them and migrates.`,
    });
  }
  for (const { env, pending } of facts.pending) {
    if (pending === 0 || facts.unprovisioned.includes(env)) continue;
    steps.push(migrateStep(env, `${migrations(pending)} ${be(pending)} not applied to ${env}. Add migrates only dev.`));
  }
  return nextOrAbsent(steps);
}

/**
 * `pithy upgrade`: migrations it counted and did not run, or a reconcile it left to the CLI it just moved.
 *
 * `reconcileWith` is set only when `--packages` moved `@pithy-sh/cli`: the running process is the old CLI,
 * so it wrote no Worker, and the project's own — through its package manager, never a global `pithy` — is
 * the one that reconciles. A dry run changed nothing to follow up on, and a failed run reports its failure.
 */
export function upgradeNext(facts: {
  env: string;
  dryRun: boolean;
  migrate: boolean;
  failed: boolean;
  pending: number;
  reconcileWith?: string;
}): NextStep[] | undefined {
  if (facts.dryRun || facts.failed) return undefined;
  if (facts.reconcileWith !== undefined) {
    return [
      {
        command: facts.reconcileWith,
        why: "@pithy-sh/cli moved, so the new one reconciles. This run wrote no Worker.",
      },
    ];
  }
  if (facts.migrate || facts.pending === 0) return undefined;
  return [
    migrateStep(
      facts.env,
      `${migrations(facts.pending)} ${be(facts.pending)} not applied to ${facts.env}. Upgrade migrates only under --migrate.`,
    ),
  ];
}

/** `pithy ui add`: dependencies it wrote into `package.json` and nothing installed. The build needs them. */
export function uiAddNext(facts: { dryRun: boolean; packageManager: string; added: number }): NextStep[] | undefined {
  if (facts.dryRun || facts.added === 0) return undefined;
  const packages = facts.added === 1 ? "1 package" : `${facts.added} packages`;
  return [
    {
      command: `${facts.packageManager} install`,
      why: `ui add wrote ${packages} into package.json, and the build needs them installed.`,
    },
  ];
}
