// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { z } from "zod";
import { establishedPending } from "../migrations/pendingCount";
import { provisionFixCommand } from "../provision/provisionFix";
import { supplyStoreEntryCommand } from "../provision/secretEntryRemedy";
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

/** `pithy upgrade --worker <worker>`: what writes a missing binding, option, or entry export. */
export function upgradeFix(worker: string): string {
  return `pithy upgrade --worker ${worker}`;
}

/**
 * A declared peer composed nowhere: adding it is the whole remedy — with its own prerequisites, because the
 * peer may declare some this Worker lacks too (`testers` → `email` → `secrets`), and `pithy add` with nobody to
 * ask refuses over them. The flag composes only what is missing, so it is right whether or not anything is.
 */
export function prerequisiteFix(worker: string, requires: string): string {
  return `pithy add ${requires} --worker ${worker} --with-prerequisites`;
}

/**
 * A capability composed and installed nowhere: `pithy add` for the first Worker composing it. Re-running it
 * is safe on the half already done. No Worker composing it is no Worker to name.
 */
export function capabilityReachFix(entry: { capability: string; workers: readonly string[] }): string | null {
  const [worker] = entry.workers;
  return worker === undefined ? null : `pithy add ${entry.capability} --worker ${worker}`;
}

/**
 * One environment's migrations, for one Worker. **Pending is `pithy migrate`**, for whatever count was
 * established — `partial` counts what answered — and needs no phrase, production included. **An environment
 * with no database is the provision**, which creates it and migrates, and names none for production, whose
 * provision is a person's (`provisionFixCommand`). An undeclared migration is a local wipe or a person's
 * judgment, and every other state established nothing, so each is `null`.
 */
export function migrationFix(entry: EnvironmentMigrations, productionEnvironments: readonly string[]): string | null {
  if (entry.state === "not-provisioned") return provisionFixCommand(entry.env, productionEnvironments);
  if (entry.state !== "checked") return null;
  return (establishedPending(entry.ledger) ?? 0) > 0 ? `pithy migrate --env ${entry.env}` : null;
}

/**
 * An unbound Secrets Store secret. **A value the kit composes** is `pithy secrets provision`, which mints the
 * entry and writes the stanza in one pass. **A value only the operator has** is supplied first, with the
 * `pithy secrets create` its sentence names; the provision that binds it is the step after.
 */
export function secretBindingFix(entry: MissingSecretBinding): string {
  return entry.provisionable ? "pithy secrets provision" : supplyStoreEntryCommand(entry);
}

/** An AI client detected here with no docs-server entry. */
export function docsConnectFix(client: string): string {
  return `pithy docs connect --client ${client}`;
}

/** A Worker whose generated `.dev.vars` holds nothing: seeding `dev` writes its values. */
export const EMPTY_DEV_VARS_FIX = "pithy seed";

/**
 * A build that renders no Turnstile widget. Only a blank sitekey in an environment `pithy turnstile provision`
 * writes is its to fill. A feature's blank is the config's to remove, and an environment no sitekey reaches
 * is not a blank at all.
 */
export function unrenderedTurnstileFix(found: UnrenderedTurnstile): string | null {
  if (!found.slot || found.environment === FEATURE_ENVIRONMENT) return null;
  return `pithy turnstile provision --worker ${found.worker}`;
}

/** A sitekey var nothing reads: the provision that writes it into `pithy.config.ts` removes it, where one does. */
export function strandedTurnstileFix(found: StrandedSitekeyVarFinding): string | null {
  return found.removedBy === null ? null : `pithy turnstile provision --worker ${found.removedBy}`;
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
      unreachable: health.capabilityReach.unreachable.map((entry) => ({ ...entry, fix: capabilityReachFix(entry) })),
      split: health.capabilityReach.split.map((entry) => ({ ...entry, ...none })),
    },
    workers: health.workers.map((worker) => {
      if (worker.state !== "checked") return worker;
      const name = worker.worker;
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
