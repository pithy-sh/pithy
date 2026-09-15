// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { type DeclaredEnvironments, isValidEnvironment } from "@pithy-sh/core/src/naming/environment";
import { z } from "zod";
import type { SecretBackend, SecretScope } from "./registry";

/**
 * The environments Pithy manages remotely — **every environment the project declares, and no other**.
 *
 * ## Declared and managed are one set. The decision, and the argument for it.
 *
 * This was a closed enum, `["staging", "prod"]`, pinned against core's `ENVIRONMENTS` by a test. That made
 * the type system say a custom environment could not be managed while the rest of the CLI cheerfully
 * accepted one: `pithy migrate --env live` ran, `<project>-live-db` would have been created, and
 * `pithy secrets provision` — iterating the enum — gave `live` no master key, no manager, and no store
 * entry, silently, until the first request. The gap was not that the enum held the wrong two names. It was
 * that a project had no way to say which environments it had, so three parts of the CLI guessed
 * differently.
 *
 * Now the project says, in the root `pithy.config.ts` (core's `DeclaredEnvironments`), and this reads it.
 *
 * **Managed could have stayed narrower than declared, and deliberately does not.** The cost of widening is
 * real and is worth naming: everything that iterates this set multiplies with it, and the largest item is
 * a manager Worker deployed per environment, each with its own rotation cron and its own D1. A project
 * declaring five environments gets five managers. The tempting alternative is a second, smaller list —
 * "declared, but only these are managed" — so the common project pays for two.
 *
 * That alternative is the bug, restated. An environment that is deployed and *not* managed is an
 * environment whose secrets have no master key: exactly the silent state `live` was already in, except now
 * with a config field that made it look intentional. There is no useful meaning for "this project deploys
 * to `live` but `live` gets no secrets" — the Worker still starts, still reads `SECRETS_ENCRYPTION_KEYS`,
 * and still fails at the first request. So the second list would only ever be a way to reintroduce the
 * silence with paperwork.
 *
 * The cost is therefore charged where it belongs: **declaring an environment is what costs a manager.** A
 * project that does not want five managers declares fewer environments, which is also true of five D1
 * databases, five KV namespaces, and five sets of resource names. The declaration is the one place that
 * decision is made and the one place `pithy doctor` can see it.
 *
 * **`dev` is still never here**, and does not need excluding: it is local-only — resolved from the
 * project's own Miniflare-backed store, seeded from the dev secrets file — and core refuses to let a
 * declaration name it at all.
 */
export const ManagedEnvironment = z
  .string()
  .refine((value) => isValidEnvironment(value) && value !== "dev", {
    error:
      "A deployed environment is a legal environment name that is not `dev`. Declare it in the root pithy.config.ts.",
  })
  .describe("A deployed environment with its own secrets store and manager (everything except local dev).");

/**
 * One deployed environment. **A validated `string`, not a union of two literals** — the union was the bug
 * this module's header describes, and a type cannot know a name the project writes down at `init`.
 */
export type ManagedEnvironment = z.output<typeof ManagedEnvironment>;

/**
 * Every managed environment, in order — the set a `global` D1 secret fans out across, and the order
 * provisioning walks. It is the declaration, unchanged: see the header for why nothing narrows it.
 *
 * The declaration is a **required** argument rather than one defaulted to `["staging", "prod"]`, because a
 * default here is indistinguishable from the silence this replaced — a caller that forgot to load the
 * project would skip `live` exactly as the closed enum did, and nothing would say so. Required, the
 * compiler names every call site instead.
 */
export function managedEnvironments(declared: DeclaredEnvironments | readonly string[]): ManagedEnvironment[] {
  return [...declared];
}

/** What a teardown was asked to act on: the environment the operator named, if any, and the project's set. */
export interface DeprovisionTarget {
  /** The environment named on the command line. Absent is a refusal, never a default. */
  environment: string | undefined;
  /** Every environment the root `pithy.config.ts` declares — what a refusal lists. */
  declared: DeclaredEnvironments | readonly string[];
}

/**
 * **The environment a teardown acts on is one the operator named (#591).**
 *
 * `secrets deprovision` used to walk every declared environment: one run, typed to clean up staging, deleted
 * production's vault. `storage deprovision --storage` and `media deprovision --storage` walked them the same
 * way, emptying and deleting production's buckets with staging's. There is no default here — not all, not the
 * first, not "everything but prod" — because any default is a set somebody did not type, and the only
 * environment worth defaulting away from is the one a default would eventually reach. So production is never
 * in a default set by there being no default set.
 *
 * Absent, or naming an environment the project does not declare, it refuses and lists what could be named.
 * Every capability teardown that deletes a per-environment resource resolves its one environment here, so the
 * refusal reads the same wherever it is met.
 */
export function deprovisionTarget(target: DeprovisionTarget): ManagedEnvironment {
  const environments = managedEnvironments(target.declared);
  const named = target.environment;
  if (named !== undefined && environments.includes(named)) return named;
  throw new ValidationError({
    message:
      named === undefined
        ? "Name the environment to deprovision. Nothing was deleted."
        : `${JSON.stringify(named)} is not an environment this project declares. Nothing was deleted.`,
    action: `Pass --env with one of: ${environments.join(", ")}.`,
  });
}

/**
 * The declared environments **other than `target`** whose capability Worker is still deployed, in declared
 * order. `runs` is the capability's own question — the secrets manager, the email worker, the classification
 * worker — asked once per other environment. The target is never asked about: its Worker is the one going.
 */
export async function otherEnvironmentsRunning(
  target: ManagedEnvironment,
  declared: DeclaredEnvironments | readonly string[],
  runs: (env: ManagedEnvironment) => Promise<boolean>,
): Promise<ManagedEnvironment[]> {
  const others: ManagedEnvironment[] = [];
  for (const env of managedEnvironments(declared)) {
    if (env !== target && (await runs(env))) others.push(env);
  }
  return others;
}

/** One project-wide part of a capability a teardown was asked to delete, and the flag that asked. */
export interface SharedPart {
  /** What it is, lowercase, as a refusal names it — `the suppression list`. */
  what: string;
  /** The flag that asked for it — what the refusal says to drop. */
  flag: string;
}

/**
 * **A part every environment shares leaves with the last environment, never before it (#591).**
 *
 * {@link deprovisionTarget} makes a teardown name one environment. Some of what a capability provisions has no
 * environment to name: email's suppression list, support's bucket and inbound rule are one per project, bound by
 * every environment. Deleting one of those from a staging teardown takes production's with it — the same defect,
 * one level up. So it refuses, before anything is deleted, while any other declared environment still runs the
 * capability's Worker. The operator tears those down first, and the last teardown takes the shared part.
 *
 * It does not replace a count. A shared part holding retained rows is still refused by `assertRetainedAgreed`
 * after this passes — this says *when* it may go, the count says the operator knows *what* goes.
 *
 * **What "still runs" does not see.** A deployed capability Worker is the proxy for "still uses it". An app
 * Worker whose stanza still binds the shared part after its environment's capability Worker is gone is not
 * asked about, and neither is a feature environment, which binds its own copies and is not declared.
 */
export async function assertSharedLeavesLast(
  target: ManagedEnvironment,
  declared: DeclaredEnvironments | readonly string[],
  runs: (env: ManagedEnvironment) => Promise<boolean>,
  shared: readonly SharedPart[],
): Promise<void> {
  if (shared.length === 0) return;
  const still = await otherEnvironmentsRunning(target, declared, runs);
  if (still.length === 0) return;
  const parts = shared.map((part) => part.what).join(" and ");
  const named = still.join(", ");
  throw new ValidationError({
    message: `${parts.charAt(0).toUpperCase()}${parts.slice(1)} ${shared.length === 1 ? "is" : "are"} shared by every environment, and ${named} still ${still.length === 1 ? "runs" : "run"}. Nothing was deleted.`,
    action: `Deprovision ${named} first, or drop ${shared.map((part) => part.flag).join(" and ")}.`,
  });
}

/**
 * The environment a `global` CF-Secrets-Store secret is canonically written through — **the last declared
 * one**.
 *
 * A Secrets Store entry is a single account-level secret that every environment binds, so it is written
 * once rather than per environment, and *which* manager does the writing has to be a stable function of
 * the project rather than of whichever environment the operator happened to type. It used to be the
 * literal `prod`, which is right for a project that has one and writes through a manager that was never
 * deployed for a project that does not.
 *
 * Last, because the declaration is ordered least-production first: the canonical writer is the most
 * production-class environment, which is the one that certainly exists and the one whose credentials are
 * scoped hardest. `["staging", "prod"]` gives `prod`, so nothing about the default project changes.
 */
export function canonicalGlobalEnvironment(
  declared: DeclaredEnvironments | readonly string[],
): ManagedEnvironment | undefined {
  return declared[declared.length - 1];
}

/**
 * The environments a write must reach, given its backend and scope — the routing the CLI applies
 * before dispatching to each env's manager (issue #26's backend × scope table):
 *
 *   - `environment` scope → exactly the requested env (its value legitimately differs per env).
 *   - `global` + `d1` → **every** declared env: each env's store is separate and keyed by its own
 *     master key, so the same value is written into each (fan-out, kept in lockstep).
 *   - `global` + `cf-secrets-store` → **the canonical env only**: a CF Secrets Store entry is one
 *     account-level secret every env binds, so it is written once, via
 *     {@link canonicalGlobalEnvironment}.
 *
 * A `global` write therefore reaches every environment by construction; an `environment` write touches
 * exactly one.
 */
export function resolveWriteTargets(
  backend: SecretBackend,
  scope: SecretScope,
  requested: ManagedEnvironment,
  declared: DeclaredEnvironments | readonly string[],
): ManagedEnvironment[] {
  if (scope === "environment") return [requested];
  if (backend === "cf-secrets-store") {
    const canonical = canonicalGlobalEnvironment(declared);
    // A declaration is never empty — core refuses that — so this only guards the caller who passed a
    // list core never validated. Falling back to the requested env writes the secret somewhere real.
    return [canonical ?? requested];
  }
  return managedEnvironments(declared);
}
