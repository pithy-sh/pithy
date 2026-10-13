// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandName, pithyCommand } from "@pithy-sh/core/src/cli/command";
import { sentenceOf } from "@pithy-sh/core/src/error/pithyError";
import { emptyPlan, type Plan, type PlanMigration, type PlanResource } from "../plan/plan";
import { EXIT } from "../terminal/exitClass";
import { deployFailureExit, type WorkerDeploy } from "./deploy";
import { type KitDeployReport, kitDeployFailed } from "./deployKit";

/**
 * **`pithy deploy --dry-run`'s plan (#697).**
 *
 * Deploy uploads Workers and does nothing else, so a plan's `resources` are its uploads: each app Worker whose
 * bundle `wrangler deploy --dry-run` accepted, and each kit Worker whose stamp says the run would ship it.
 * `files`, `migrations`, `secrets` and `data` stay empty, because a deploy writes none of them.
 *
 * **What a deploy does not do goes in `notes`.** The migrations it would leave unapplied are named there,
 * never in `plan.migrations`: that list is what a command would apply, and a deploy applies none — saying
 * otherwise would be the promise a plan exists not to make. A binding with no id is not a note: it is the
 * refusal the deploy makes, and its dry run makes it too, before there is a plan to put it in.
 */

/** What the dry run learned about the target environment's unapplied migrations. */
export type PendingRead =
  /** A bare deploy, which ships each Worker's top-level stanza and has no remote schema to ask about. */
  | { state: "skipped" }
  /** Every migration the environment's databases have not applied. */
  | { state: "read"; migrations: PlanMigration[] }
  /** The ledger could not be read, and why. Never a failed dry run: a deploy does not migrate. */
  | { state: "unread"; reason: string };

/** Everything the plan is assembled from, gathered by `commands/deploy.ts` in the order the deploy runs. */
export interface DeployPlanInput {
  /** The environment deployed, or `undefined` for a bare deploy. */
  env: string | undefined;
  /** The migrations the target has not applied. */
  pending: PendingRead;
  /** The app Workers' rows, each from `wrangler deploy --dry-run`. Empty when `--kit` narrowed the run. */
  deploys: readonly WorkerDeploy[];
  /** The kit half's report, or `null` when it did not run. */
  kit: KitDeployReport | null;
}

/**
 * The unapplied migrations, read the way `pithy migrate --dry-run` reads them — `read` is
 * `planMigrateProject` over the deploy's environment. A bare deploy reads nothing; a read that fails is a
 * reason rather than a failure, exactly as the real deploy's warning is best-effort.
 */
export async function readPendingForPlan(
  env: string | undefined,
  read: () => Promise<PlanMigration[]>,
): Promise<PendingRead> {
  if (env === undefined) return { state: "skipped" };
  try {
    return { state: "read", migrations: (await read()).filter((migration) => migration.direction === "up") };
  } catch (error) {
    return { state: "unread", reason: sentenceOf(error) };
  }
}

/** The note naming every unapplied migration and the command that applies them, or nothing. */
function pendingNote(env: string | undefined, pending: PendingRead): string | undefined {
  if (pending.state === "unread") return `Pending migrations for ${env} were not read. ${pending.reason}`;
  if (pending.state === "skipped" || pending.migrations.length === 0) return undefined;
  const count = pending.migrations.length;
  const names = pending.migrations.map((migration) => migration.name).join(", ");
  return `${count} migration${count === 1 ? "" : "s"} unapplied for ${env}: ${names}. Deploy does not migrate — ${env === undefined ? `migrate with ${commandName("migrate")} and its --env` : `run ${pithyCommand("migrate", { flags: { "--env": env } })}`}.`;
}

/** The plan `pithy deploy --dry-run --json` carries under `plan`. */
export function deployPlan(input: DeployPlanInput): Plan {
  const plan = emptyPlan();
  const env = input.env === undefined ? {} : { env: input.env };
  for (const deploy of input.deploys) {
    if (deploy.ok) plan.resources.push({ kind: "worker", name: deploy.name, ...env, action: "upload" });
  }
  for (const planned of input.kit?.planned ?? []) {
    const upload: PlanResource = { kind: "worker", name: planned.worker, ...env, action: "upload" };
    plan.resources.push({ ...upload, reason: planned.reason });
  }
  const pending = pendingNote(input.env, input.pending);
  if (pending !== undefined) plan.notes.push(pending);
  return plan;
}

/**
 * The exit code a dry run ends with: the one the real deploy would have. A Worker or a kit half that would
 * fail is 1, a report with a failed row, or the class a refused Worker's row carries (`deployFailureExit`);
 * otherwise 0. Unapplied migrations never fail it, as they never fail a deploy. A refusal on the first Worker
 * never reaches here: the dry run throws it before planning, as the deploy does.
 */
export function deployPlanExit(input: DeployPlanInput): number {
  const appsFailed = input.deploys.some((deploy) => !deploy.ok);
  const kitFailed = input.kit !== null && kitDeployFailed(input.kit);
  if (appsFailed) return deployFailureExit(input.deploys);
  return kitFailed ? EXIT.failed : EXIT.ok;
}
