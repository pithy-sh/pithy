// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { defineCommand } from "citty";
import { createCliAudit } from "../audit/cliAudit";
import { countPendingMigrations } from "../migrations/run";
import { deployProject, pendingWarning, summarizeDeploy } from "../project/deploy";
import { projectCapabilities, resolveWorkers } from "../project/workerScope";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";

/**
 * How many migrations are unapplied for the target env — best-effort, never blocking. Deploy and
 * migrate are orthogonal (deploy never migrates), so a config that can't load or a database it can't
 * reach yields `undefined` (no warning) rather than failing the deploy.
 *
 * Deploy ships every Worker, so the count does too — it fans out over `apps/*` exactly as `pithy migrate`
 * would. The warning is about the project's schema being behind, and a table any Worker owns is one this
 * deploy's code may read.
 */
async function pendingFor(projectDir: string, env: string): Promise<number | undefined> {
  try {
    return await countPendingMigrations({ projectDir, env });
  } catch {
    return undefined;
  }
}

/**
 * The audit emitter for `pithy deploy`. Shipping code to an environment is exactly the kind of action
 * an audit trail exists for, so every worker deploy — success or failure — is recorded when the project
 * has audit wired. A bare `pithy deploy` (no `--env`) still targets the project's own app database, the
 * same one `dev` reads (see `resolveAuditDatabaseId`), so the fallback lines up with the real target.
 */
async function buildAudit(projectDir: string, env: string) {
  const vars = loadCloudflareEnv(projectDir);
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return async () => {};
  // `audit` composed by any Worker means the project has a trail; deploy spans them all.
  const capabilities = await resolveWorkers({ projectDir })
    .then(projectCapabilities)
    .catch(() => []);
  return createCliAudit({
    projectDir,
    env,
    capabilities,
    clients: new CloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}

export default defineCommand({
  meta: { name: "deploy", description: "Deploy to Cloudflare Workers" },
  args: {
    env: { type: "string", description: "Target environment (omit for each worker's top-level config)" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();

      // The migration warning only makes sense against a concrete remote target. A bare `pithy deploy`
      // ships each worker's top-level config, whose deployed schema is not the local dev D1 — so skip the
      // check (and its REST round trip) unless an `--env` names the environment being deployed.
      const pending = args.env ? await pendingFor(projectDir, args.env) : undefined;
      const audit = await buildAudit(projectDir, args.env ?? "dev");
      const deploys = await deployProject({ projectDir, env: args.env, audit });
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
