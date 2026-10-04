// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { generatedMigrationGroup } from "@pithy-sh/core/src/migrations/groups";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { defineCommand } from "citty";
import { DESTROY_RETAINED_DESCRIPTION, parseDestroyRetained, rollbackConfirmPhrase } from "../migrations/confirm";
import { requireMigrationGroup } from "../migrations/groups";
import {
  type MigrationProgress,
  migratedBeforeFailure,
  migrateProject,
  type WorkerMigrationRun,
} from "../migrations/run";
import { loadProject, projectCloudflareAccount, requireProjectName } from "../project/config";
import { ENV_ARG, requireEnvironment } from "../project/environment";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * One line per worker: which migrations moved, in which direction (docs/CLI.md §3). A worker's
 * databases are folded into one line — the migration names already carry their capability namespace,
 * and a run is read worker by worker.
 */
function describe(run: WorkerMigrationRun, rollback: boolean): string {
  const names = run.databases.flatMap((database) => database.results.map((result) => result.migrationName));
  if (names.length === 0) return `nothing to ${rollback ? "roll back" : "apply"}.`;
  return `${names.join(", ")} ${rollback ? "rolled back" : "applied"}.`;
}

/** What a render of this command is told: who ran it, where, which way, and under which group. */
export interface MigrateRender {
  /** The project every database in the run is stamped with. */
  project: string;
  /** The environment migrated. */
  env: string;
  /** Whether the run reversed a group rather than running forward. */
  rollback: boolean;
  /** Machine-readable output. */
  json: boolean;
  /**
   * The run's group (#694) — the caller's `--group`, or the timestamp this run generated for itself.
   * Optional because a rollback that was refused never renders, and a caller rendering a report of its
   * own may hold no group.
   */
  group?: string;
}

/**
 * Render a fan-out run: one worker per line, whitespace-aligned (docs/CLI.md §3.5), or the single
 * `--json` line whose `workers` array groups the run exactly as the human output does. Split out so the
 * output contract is testable without a project on disk.
 *
 * **A successful forward run names its group on one line** (#694). It is the handle to everything groups
 * add — `--rollback --group <it>` is what reverses this run — and it is printed whether the caller named
 * the group or the run generated it, because the alternative is making somebody run the wrong command
 * once in order to learn the right one. A run that applied nothing names none: there is nothing in it. A
 * rollback names none either; the operator typed it, and `--json` carries it both ways regardless.
 */
export function formatMigrateReport(workers: WorkerMigrationRun[], options: MigrateRender): string {
  if (options.json) {
    const payload = {
      command: "migrate",
      project: options.project,
      env: options.env,
      rollback: options.rollback,
      group: options.group,
    };
    return `${formatJsonLine({ ...payload, workers })}\n`;
  }
  if (workers.every((worker) => worker.databases.length === 0)) return `Nothing to migrate.\n${formatDone()}\n`;

  const width = Math.max(...workers.map((worker) => worker.worker.length));
  const lines = workers.map((worker) => `${worker.worker.padEnd(width)}  ${describe(worker, options.rollback)}`);
  lines.push(...keptLines(workers));
  if (!options.rollback && options.group !== undefined && moved(workers)) lines.push(`Group: ${options.group}`);
  return `${lines.join("\n")}\n${formatDone()}\n`;
}

/** Whether anything actually moved — what decides a group line, and what a `kept` row does not count as. */
function moved(workers: WorkerMigrationRun[]): boolean {
  return workers.some((worker) => worker.databases.some((database) => database.results.length > 0));
}

/**
 * One line per database a rollback left alone because another environment binds it (#588). Once per
 * database, not per Worker: two Workers sharing it would otherwise say the same thing twice.
 */
function keptLines(workers: WorkerMigrationRun[]): string[] {
  const seen = new Map<string, string[]>();
  for (const database of workers.flatMap((worker) => worker.databases)) {
    if (database.boundBy && !seen.has(database.binding)) seen.set(database.binding, database.boundBy);
  }
  return [...seen].map(([binding, boundBy]) => `${binding} kept. ${boundBy.join(", ")} binds it too.`);
}

/**
 * What a run that died partway did before it died (#380).
 *
 * A fan-out has no transaction across databases: the third one throws and the first two are already
 * ahead of it. Until now the throw took the whole report with it, so the operator was told a migration
 * failed and nothing about which schemas had moved — on the one command where that is the first
 * question. `withErrorReporting` writes the failure to stderr and exits 1; this writes what the run did
 * to stdout first, so both streams and the exit code agree that it failed and name what it changed.
 *
 * The three states are kept apart on purpose. A database that migrated, the one that failed, and one
 * the run never opened are three different things to do next, and a single list would make them one.
 */
export function formatMigrateProgress(progress: MigrationProgress, options: MigrateRender): string {
  if (options.json) {
    return `${formatJsonLine({
      command: "migrate",
      project: options.project,
      env: options.env,
      rollback: options.rollback,
      group: options.group,
      workers: progress.migrated,
      failed: progress.failed,
      unreached: progress.unreached,
      interrupted: true,
    })}\n`;
  }
  const lines = progress.migrated
    .filter((worker) => worker.databases.length > 0)
    .map((worker) => `${worker.worker}  ${describe(worker, options.rollback)}`);
  lines.push(...keptLines(progress.migrated));
  lines.push(
    `${progress.failed.binding} (${progress.failed.database}) failed. Its schema is where the failure left it.`,
  );
  if (progress.unreached.length > 0) {
    const named = progress.unreached.map((target) => `${target.binding} (${target.database})`).join(", ");
    lines.push(`Not reached: ${named}.`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Ask a terminal for the rollback phrase — never under `--json`, never without a TTY, and never for `dev`,
 * which needs none. The prompt says what the command does, and **which group it is about to reverse**,
 * before asking anyone to agree to it (#694). With no group named it says so rather than naming one: the
 * phrase is checked before any database is read, so this is asked ahead of the refusal that names the
 * group on top.
 */
async function promptRollback(env: string, json: boolean, group: string | undefined): Promise<string | undefined> {
  const interactive = !json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  if (!interactive || env === LOCAL_ENVIRONMENT) return undefined;
  const { isCancel, text } = await import("@clack/prompts");
  const subject = group === undefined ? "a group of migrations" : `group ${group}`;
  const answer = await text({
    message: `This reverses ${subject} in every database ${env} binds. Type "${rollbackConfirmPhrase(env)}" to confirm:`,
  });
  return isCancel(answer) ? "" : answer;
}

export default defineCommand({
  meta: { name: "migrate", description: "Run migrations for an environment" },
  args: {
    env: ENV_ARG,
    worker: { type: "string", description: "Migrate one worker instead of every worker in apps/" },
    binding: { type: "string", description: "Migrate only the database behind this D1 binding" },
    group: {
      type: "string",
      description:
        "Name the group this run applies under, instead of the timestamp it would generate. Required by --rollback, which reverses the named group",
    },
    rollback: {
      type: "boolean",
      default: false,
      description:
        "Reverse the --group named, in every database in scope (narrow with --worker and --binding). Refuses without a group, and refuses to drop rows in retained tables",
    },
    "confirm-rollback": {
      type: "string",
      description: 'Unlock a non-dev rollback non-interactively: "yes, i really want to roll back <env>"',
    },
    "destroy-retained": { type: "string", description: DESTROY_RETAINED_DESCRIPTION },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const env = requireEnvironment(args.env);
      const projectDir = process.cwd();
      // The non-guessing name: it is stamped into every database this run touches, and a later run
      // checks against it, so a fallback that differs between checkouts would lock a project out of
      // its own database. `requireProjectName` refuses to guess (docs/CLI.md §3.3).
      const project = requireProjectName(await loadProject(projectDir));
      // And the account this project belongs to, before anything resolves a credential. `migrateProject`
      // states the hazard in its own words: a remote migration alters a real schema, so the wrong
      // account's credentials would run it against another company's database (#206). This command is
      // the one that has to supply the answer, and for a long while it did not.
      const account = await projectCloudflareAccount(projectDir);
      // One group for the whole run. A forward run that names none is stamped with the moment it ran —
      // resolved here, so the line this command prints and the value the run records are the same one. A
      // rollback is handed exactly what the operator passed: none is the refusal, not a new group (#694).
      const named = requireMigrationGroup(args.group);
      const group = args.rollback ? named : (named ?? generatedMigrationGroup());
      const render = {
        project,
        env,
        rollback: args.rollback,
        json: args.json,
        ...(group !== undefined ? { group } : {}),
      };
      const destroyRetained = parseDestroyRetained(args["destroy-retained"]);
      // A rollback outside dev is asked for in words (#588). The flag wins wherever it is present; a
      // terminal without it is asked; a script without it is refused by `migrateProject`, which checks.
      const confirmRollback =
        args.rollback && args["confirm-rollback"] === undefined
          ? await promptRollback(env, args.json, group)
          : args["confirm-rollback"];
      let workers: WorkerMigrationRun[];
      try {
        workers = await migrateProject({
          projectDir,
          project,
          account,
          env,
          ...(args.worker !== undefined ? { worker: args.worker } : {}),
          ...(args.binding !== undefined ? { binding: args.binding } : {}),
          ...(group !== undefined ? { group } : {}),
          rollback: args.rollback,
          ...(confirmRollback !== undefined ? { confirmRollback } : {}),
          ...(destroyRetained !== undefined ? { destroyRetained } : {}),
        });
      } catch (error) {
        // A run that failed on the third database has already moved the first two, and until #380 the
        // report of it died with the throw. What ran is printed here, then the same error is rethrown
        // unchanged for `withErrorReporting` to render and exit 1 on.
        const progress = migratedBeforeFailure(error);
        if (progress) process.stdout.write(formatMigrateProgress(progress, render));
        throw error;
      }
      process.stdout.write(formatMigrateReport(workers, render));
    }),
});
