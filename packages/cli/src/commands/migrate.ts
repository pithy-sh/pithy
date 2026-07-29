import { defineCommand } from "citty";
import { migrateProject, type WorkerMigrationRun } from "../migrations/run";
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
  options: { env: string; rollback: boolean; json: boolean },
): string {
  if (options.json) {
    return `${formatJsonLine({ command: "migrate", env: options.env, rollback: options.rollback, workers })}\n`;
  }
  if (workers.every((worker) => worker.databases.length === 0)) return `Nothing to migrate.\n${formatDone()}\n`;

  const width = Math.max(...workers.map((worker) => worker.worker.length));
  const lines = workers.map((worker) => `${worker.worker.padEnd(width)}  ${describe(worker, options.rollback)}`);
  return `${lines.join("\n")}\n${formatDone()}\n`;
}

export default defineCommand({
  meta: { name: "migrate", description: "Run migrations for an environment" },
  args: {
    env: { type: "string", default: "dev", description: "Target environment" },
    worker: { type: "string", description: "Migrate one worker instead of every worker in apps/" },
    rollback: { type: "boolean", default: false, description: "Step the latest migration back" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const workers = await migrateProject({
        projectDir,
        env: args.env,
        ...(args.worker !== undefined ? { worker: args.worker } : {}),
        rollback: args.rollback,
      });
      process.stdout.write(formatMigrateReport(workers, { env: args.env, rollback: args.rollback, json: args.json }));
    }),
});
