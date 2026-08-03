// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCommand } from "citty";
import { migrateProject, type WorkerMigrationRun } from "../migrations/run";
import { loadProject, requireProjectName } from "../project/config";
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
      const workers = await migrateProject({
        projectDir,
        project,
        env,
        ...(args.worker !== undefined ? { worker: args.worker } : {}),
        rollback: args.rollback,
      });
      process.stdout.write(formatMigrateReport(workers, { project, env, rollback: args.rollback, json: args.json }));
    }),
});
