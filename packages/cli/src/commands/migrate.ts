// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCommand } from "citty";
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

/**
 * Render a fan-out run: one worker per line, whitespace-aligned (docs/CLI.md §3.5), or the single
 * `--json` line whose `workers` array groups the run exactly as the human output does. Split out so the
 * output contract is testable without a project on disk.
 */
export function formatMigrateReport(
  workers: WorkerMigrationRun[],
  options: { project: string; env: string; rollback: boolean; json: boolean },
): string {
  if (options.json) {
    const payload = { command: "migrate", project: options.project, env: options.env, rollback: options.rollback };
    return `${formatJsonLine({ ...payload, workers })}\n`;
  }
  if (workers.every((worker) => worker.databases.length === 0)) return `Nothing to migrate.\n${formatDone()}\n`;

  const width = Math.max(...workers.map((worker) => worker.worker.length));
  const lines = workers.map((worker) => `${worker.worker.padEnd(width)}  ${describe(worker, options.rollback)}`);
  return `${lines.join("\n")}\n${formatDone()}\n`;
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
export function formatMigrateProgress(
  progress: MigrationProgress,
  options: { project: string; env: string; rollback: boolean; json: boolean },
): string {
  if (options.json) {
    return `${formatJsonLine({
      command: "migrate",
      project: options.project,
      env: options.env,
      rollback: options.rollback,
      workers: progress.migrated,
      failed: progress.failed,
      unreached: progress.unreached,
      interrupted: true,
    })}\n`;
  }
  const lines = progress.migrated
    .filter((worker) => worker.databases.length > 0)
    .map((worker) => `${worker.worker}  ${describe(worker, options.rollback)}`);
  lines.push(
    `${progress.failed.binding} (${progress.failed.database}) failed. Its schema is where the failure left it.`,
  );
  if (progress.unreached.length > 0) {
    const named = progress.unreached.map((target) => `${target.binding} (${target.database})`).join(", ");
    lines.push(`Not reached: ${named}.`);
  }
  return `${lines.join("\n")}\n`;
}

export default defineCommand({
  meta: { name: "migrate", description: "Run migrations for an environment" },
  args: {
    env: ENV_ARG,
    worker: { type: "string", description: "Migrate one worker instead of every worker in apps/" },
    rollback: { type: "boolean", default: false, description: "Step the latest migration back" },
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
      const render = { project, env, rollback: args.rollback, json: args.json };
      let workers: WorkerMigrationRun[];
      try {
        workers = await migrateProject({
          projectDir,
          project,
          account,
          env,
          ...(args.worker !== undefined ? { worker: args.worker } : {}),
          rollback: args.rollback,
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
