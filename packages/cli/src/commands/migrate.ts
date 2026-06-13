import { defineCommand } from "citty";
import { type DatabaseRun, migrateProject } from "../migrations/run";
import { allCapabilities, loadProject } from "../project/config";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/** One line per database: what moved, in which direction (docs/CLI.md §3). */
function describe(run: DatabaseRun, rollback: boolean): string {
  const count = run.results.length;
  if (count === 0) return `${run.database}: nothing to ${rollback ? "roll back" : "apply"}.`;
  return `${run.database}: ${count} ${rollback ? "rolled back" : "applied"}.`;
}

export default defineCommand({
  meta: { name: "migrate", description: "Run migrations for an environment" },
  args: {
    env: { type: "string", default: "dev", description: "Target environment" },
    rollback: { type: "boolean", default: false, description: "Step the latest migration back" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const config = await loadProject(projectDir);
      const runs = await migrateProject({
        capabilities: allCapabilities(config),
        projectDir,
        env: args.env,
        rollback: args.rollback,
      });

      if (args.json) {
        process.stdout.write(
          `${formatJsonLine({ command: "migrate", env: args.env, rollback: args.rollback, databases: runs })}\n`,
        );
        return;
      }
      if (runs.length === 0) {
        process.stdout.write("Nothing to migrate.\n");
      }
      for (const run of runs) {
        process.stdout.write(`${describe(run, args.rollback)}\n`);
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});
