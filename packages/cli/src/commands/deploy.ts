import { defineCommand } from "citty";
import { countPendingMigrations } from "../migrations/run";
import { allCapabilities, loadProject } from "../project/config";
import { deployProject, pendingWarning, summarizeDeploy } from "../project/deploy";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * How many migrations are unapplied for the target env — best-effort, never blocking. Deploy and
 * migrate are orthogonal (deploy never migrates), so a config that can't load or a database it can't
 * reach yields `undefined` (no warning) rather than failing the deploy.
 */
async function pendingFor(projectDir: string, env: string): Promise<number | undefined> {
  try {
    const config = await loadProject(projectDir);
    return await countPendingMigrations({ capabilities: allCapabilities(config), projectDir, env });
  } catch {
    return undefined;
  }
}

export default defineCommand({
  meta: { name: "deploy", description: "Deploy to Cloudflare Workers" },
  args: {
    env: { type: "string", description: "Target environment (omit to deploy the top-level worker)" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();

      // The migration warning only makes sense against a concrete remote target. A bare `pithy deploy`
      // ships the top-level worker, whose deployed schema is not the local dev D1 — so skip the check
      // (and its REST round trip) unless an `--env` names the environment being deployed.
      const pending = args.env ? await pendingFor(projectDir, args.env) : undefined;
      const deploys = await deployProject({ projectDir, env: args.env });
      const failed = deploys.some((deploy) => !deploy.ok);

      if (args.json) {
        process.stdout.write(
          `${formatJsonLine({
            command: "deploy",
            env: args.env ?? null,
            pendingMigrations: pending ?? null,
            workers: deploys,
          })}\n`,
        );
        if (failed) process.exitCode = 1;
        return;
      }

      const warning = args.env ? pendingWarning(pending, args.env) : undefined;
      if (warning) process.stdout.write(`${warning}\n`);
      for (const deploy of deploys) process.stdout.write(`${summarizeDeploy(deploy)}\n`);
      if (failed) {
        process.exitCode = 1; // The per-worker failure lines are the report; exit non-zero for CI.
        return;
      }
      process.stdout.write(`${formatDone()}\n`);
    }),
});
