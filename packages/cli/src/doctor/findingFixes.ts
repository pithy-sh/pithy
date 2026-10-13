// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Command, pithyCommand, type WorkerDir } from "@pithy-sh/core/src/cli/command";
import { FEATURE_ENVIRONMENT, LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { z } from "zod";
import { type AddPlan, addPlan, projectAddFacts } from "../capabilities/addCommand";
import type { McpClientId } from "../mcp/clients";
import { establishedPending } from "../migrations/pendingCount";
import { provisionFixCommand } from "../provision/provisionFix";
import { supplyStoreEntryCommand } from "../provision/secretEntryRemedy";
import type { UnreachableCapability } from "./capabilityReach";
import type { EnvironmentMigrations } from "./environmentMigrations";
import type { ProjectHealth } from "./health";
import type { MissingSecretBinding } from "./secretBindings";
import type { StrandedSitekeyVarFinding, UnrenderedTurnstile } from "./turnstileSitekeys";

/**
 * **The command that rights one `pithy doctor` finding, gated or not (#697).**
 *
 * `failures.ts` is the exit gate, and each of its entries carries `fix`. The findings that report and never
 * gate — a deployed environment's pending migrations, an unbound secret, an AI client nobody connected — are
 * faults too, and an agent reading `--json` had their prose and no command. So every finding entry in a
 * report block carries `fix`: a whole `pithy` command run as written, or `null` where none rights it.
 * `devSecrets` and `devVarsLocal` are the exception — they sort names into classes, and carry none. The rule
 * is `failures.ts`'s — an edit, a person's step, or a command that would lose data run blind is `null` — and
 * where a finding gates, the two read the same builder here, so the exit's `fix` and the block's cannot
 * disagree.
 *
 * Built from each finding's fields, never from a printed sentence. `failures.test.ts` reads the finding lists
 * off the schema `pithy schema doctor` publishes, holds a rendered report to it — every list present, every
 * entry with `fix` — and runs each `fix` against the real command tree and its declared flags.
 */

/** A `fix`: the command that rights a finding, or `null` when none does. */
export const DoctorFix = z
  .string()
  .min(1)
  .nullable()
  .describe(
    "A `pithy` command that rights it, run as written, or `null` when none does — an edit, a person's step, or a command that would lose data run blind. `detail` says which.",
  );
export type DoctorFix = z.infer<typeof DoctorFix>;

/** `pithy upgrade` for one Worker: what writes a missing binding, option, or entry export. */
export function upgradeFix(worker: WorkerDir): Command {
  return pithyCommand("upgrade", { flags: { "--worker": worker } });
}

/**
 * A declared peer composed nowhere: adding it is the whole remedy — with its own prerequisites, because the
 * peer may declare some this Worker lacks too (`testers` → `email` → `secrets`), and `pithy add` with nobody to
 * ask refuses over them. The flag composes only what is missing, so it is right whether or not anything is.
 */
export function prerequisitePlan(worker: WorkerDir, requires: string, projectDir?: string): AddPlan {
  return addPlan({ capability: requires, workers: [worker], factsFor: projectAddFacts(projectDir) });
}

/** {@link prerequisitePlan}'s `fix`: the one command, when nothing in it is a person's choice. */
export function prerequisiteFix(worker: WorkerDir, requires: string, projectDir?: string): Command | null {
  return prerequisitePlan(worker, requires, projectDir).fix ?? null;
}

/**
 * A capability composed and installed nowhere: `pithy add` for the first Worker composing it. Re-running it
 * is safe on the half already done. No Worker composing it is no Worker to name.
 *
 * With `--with-prerequisites` (#711), on `addCommand`'s rule: the package is installed nowhere, so no manifest
 * can rule its prerequisites out, and without the flag `pithy add` with nobody to ask refuses over any it has.
 */
export function capabilityReachPlan(entry: ReachEntry, projectDir?: string): AddPlan | null {
  const [worker] = entry.workers;
  if (worker === undefined) return null;
  // What that Worker's config already settles (#711): a prerequisite it composes is not missing, and an option its
  // registration states is not a choice — `pithy add` skips it, so naming one per value asks the reader to pick
  // what the config has already decided, and leaves an agent no fix.
  return addPlan({
    capability: entry.capability,
    workers: [worker],
    factsFor: projectAddFacts(projectDir),
    ...(entry.settled === undefined
      ? {}
      : { composed: new Set(entry.settled.composed), answered: new Set(entry.settled.answered) }),
  });
}

/** What {@link capabilityReachPlan} reads of an unreachable capability. */
type ReachEntry = Pick<UnreachableCapability, "capability" | "workers" | "settled">;

/** {@link capabilityReachPlan}'s `fix`, where it has one. */
export function capabilityReachFix(entry: ReachEntry, projectDir?: string): Command | null {
  return capabilityReachPlan(entry, projectDir)?.fix ?? null;
}

/**
 * One environment's migrations, for one Worker. **Pending is `pithy migrate`**, for whatever count was
 * established — `partial` counts what answered — and needs no phrase, production included. **An environment
 * with no database is the provision**, which creates it and migrates, and names none for production, whose
 * provision is a person's (`provisionFixCommand`). An undeclared migration is a local wipe or a person's
 * judgment, and every other state established nothing, so each is `null`.
 */
export function migrationFix(entry: EnvironmentMigrations, productionEnvironments: readonly string[]): Command | null {
  if (entry.state === "not-provisioned") return provisionFixCommand(entry.env, productionEnvironments);
  if (entry.state !== "checked") return null;
  return (establishedPending(entry.ledger) ?? 0) > 0
    ? pithyCommand("migrate", { flags: { "--env": entry.env } })
    : null;
}

/**
 * An unbound Secrets Store secret. **A value the kit composes** has no `fix`: `pithy secrets provision` mints it, and
 * runs against every environment, production included — a person's decision, never the fix for one environment's
 * binding (#711). **A value only the operator has** is supplied first, with the `pithy secrets create` its sentence
 * names; the provision that binds it is the step after.
 */
export function secretBindingFix(entry: MissingSecretBinding): Command | null {
  return entry.provisionable ? null : supplyStoreEntryCommand(entry);
}

/** An AI client detected here with no docs-server entry. */
export function docsConnectFix(client: McpClientId): Command {
  return pithyCommand("docs connect", { flags: { "--client": client } });
}

/** A Worker whose generated `.dev.vars` holds nothing: seeding `dev` writes its values. */
export const EMPTY_DEV_VARS_FIX = pithyCommand("seed", { flags: { "--env": LOCAL_ENVIRONMENT } });

/**
 * A build that renders no Turnstile widget. Only a blank sitekey in an environment `pithy turnstile provision`
 * writes is its to fill. A feature's blank is the config's to remove, and an environment no sitekey reaches
 * is not a blank at all.
 */
export function unrenderedTurnstileFix(found: UnrenderedTurnstile): Command | null {
  if (!found.slot || found.environment === FEATURE_ENVIRONMENT) return null;
  return pithyCommand("turnstile provision", { flags: { "--worker": found.worker } });
}

/** A sitekey var nothing reads: the provision that writes it into `pithy.config.ts` removes it, where one does. */
export function strandedTurnstileFix(found: StrandedSitekeyVarFinding): Command | null {
  return found.removedBy === null
    ? null
    : pithyCommand("turnstile provision", { flags: { "--worker": found.removedBy } });
}

/**
 * A two-state declaration with `fix: null` beside each entry of one of its lists, once it was read. An
 * unreadable one has no entries, and its `problem` is the edit.
 */
function withNoFix<T extends { state: string }, K extends string>(declaration: T, list: K): T {
  if (declaration.state !== "read") return declaration;
  const entries = (declaration as T & Record<K, object[]>)[list];
  return { ...declaration, [list]: entries.map((entry) => ({ ...entry, fix: null })) };
}

/**
 * `project.health` as `--json` carries it: the health itself, with `fix` beside each finding entry. The
 * domain type stays without one — `pithy upgrade` reuses it — so the field is added here, on the way out.
 *
 * A finding whose remedy is an edit, a decision or a carry a person walks carries `fix: null`: a decline, a
 * generated value the kit would write differently and a pin that keeps nothing, a manifest somebody else's
 * package shipped, a split or divergent project-global binding, a capability its Workers resolve at two
 * versions.
 */
export function healthWithFixes(health: ProjectHealth, productionEnvironments: readonly string[]): unknown {
  const none = { fix: null };
  return {
    ...health,
    manifests: { ...health.manifests, faults: health.manifests.faults.map((fault) => ({ ...fault, ...none })) },
    bindingScope: {
      ...health.bindingScope,
      split: health.bindingScope.split.map((entry) => ({ ...entry, ...none })),
      divergent: health.bindingScope.divergent.map((entry) => ({ ...entry, ...none })),
    },
    capabilityReach: {
      ...health.capabilityReach,
      // What the Worker settles is read for the fix, and is not part of the report.
      unreachable: health.capabilityReach.unreachable.map(({ settled, ...entry }) => ({
        ...entry,
        fix: capabilityReachFix({ ...entry, settled }),
      })),
      split: health.capabilityReach.split.map((entry) => ({ ...entry, ...none })),
    },
    workers: health.workers.map((worker) => {
      if (worker.state !== "checked") return worker;
      const name = worker.directory;
      return {
        ...worker,
        prerequisites: {
          ...worker.prerequisites,
          missing: worker.prerequisites.missing.map((entry) => ({
            ...entry,
            fix: prerequisiteFix(name, entry.requires),
          })),
        },
        config: {
          ...worker.config,
          drift: worker.config.drift.map((drift) => ({ ...drift, fix: upgradeFix(name) })),
        },
        bindings: {
          ...worker.bindings,
          missing: worker.bindings.missing.map((binding) => ({ ...binding, fix: upgradeFix(name) })),
          declinedBindings: withNoFix(worker.bindings.declinedBindings, "declines"),
          generatedValues: withNoFix(withNoFix(worker.bindings.generatedValues, "drift"), "stalePins"),
        },
        migrations: {
          ...worker.migrations,
          environments: worker.migrations.environments.map((entry) => ({
            ...entry,
            fix: migrationFix(entry, productionEnvironments),
          })),
        },
      };
    }),
  };
}
