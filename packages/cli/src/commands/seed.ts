// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { defineCommand } from "citty";
import { type CliAuditEmit, createRemoteCliAudit } from "../audit/cliAudit";
import { type ResetPreviewEntry, resolveWorkerScopes } from "../migrations/run";
import { loadProject } from "../project/config";
import { type SeedWorkerReport, seedProject } from "../seed/run";
import { PRODUCTION_CONFIRM_PHRASE, resetConfirmPhrase } from "../seed/safety";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";
import { saffron } from "../terminal/style";

/** One line per set: what it wrote, per backend (docs/CLI.md §3). Empty backends are omitted. */
function describeSet(set: {
  name: string;
  d1: { rows: number }[];
  kv: { entries: number }[];
  r2: unknown[];
  media: unknown[];
}): string {
  const rows = set.d1.reduce((sum, entry) => sum + entry.rows, 0);
  const entries = set.kv.reduce((sum, entry) => sum + entry.entries, 0);
  const parts: string[] = [];
  if (rows > 0) parts.push(`${rows} row${rows === 1 ? "" : "s"}`);
  if (entries > 0) parts.push(`${entries} entr${entries === 1 ? "y" : "ies"}`);
  if (set.r2.length > 0) parts.push(`${set.r2.length} object${set.r2.length === 1 ? "" : "s"}`);
  if (set.media.length > 0) parts.push(`${set.media.length} asset${set.media.length === 1 ? "" : "s"}`);
  return `${set.name}: ${parts.length > 0 ? parts.join(", ") : "nothing to seed"}.`;
}

/** One line per reset database: schema dropped and recreated, or (dry run) what would be (docs/CLI.md §3). */
function describeReset(entry: ResetPreviewEntry, dryRun: boolean): string {
  const migrations = `${entry.migrations} migration${entry.migrations === 1 ? "" : "s"}`;
  return dryRun
    ? `Would reset ${entry.database} (${entry.binding}): ${migrations}.`
    : `Reset ${entry.database} (${entry.binding}): ${migrations} rolled back and reapplied.`;
}

/**
 * One worker's block of the run report: its sets, then what it skipped and why. A worker is named on
 * every line so a fan-out over several workers reads as one list, not several interleaved ones.
 */
function describeWorker(worker: SeedWorkerReport, env: string, width: number): string {
  const name = worker.worker.padEnd(width);
  const lines: string[] = [];
  for (const key of worker.skippedByEnv) lines.push(`${name}  skipped ${key}: not allowed in ${env}.`);
  for (const key of worker.shared) lines.push(`${name}  ${key}: already seeded by another worker.`);
  for (const set of worker.sets) lines.push(`${name}  ${describeSet(set)}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * The audit emitter for a seed run, or a no-op when auditing is unavailable. A `--redo` schema reset is
 * the most destructive thing the seeder does, so it must leave a record of who reset which environment.
 */
async function buildSeedAudit(
  projectDir: string,
  env: string,
  capabilities: readonly Capability[],
): Promise<CliAuditEmit> {
  const vars = loadCloudflareEnv(projectDir);
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return async () => {};
  // Data-plane: a `dev` seed or reset only touches local Miniflare, so it is not audited.
  return createRemoteCliAudit({
    projectDir,
    env,
    capabilities,
    clients: new CloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}

/** The interactive reset-confirm prompt. Names the destruction plainly before asking for the phrase. */
function resetPrompt(env: string): () => Promise<string> {
  return async () => {
    const { isCancel, text } = await import("@clack/prompts");
    const answer = await text({
      message: `DESTRUCTIVE: this drops every table in ${env} and all data is lost. Type "${resetConfirmPhrase(env)}" to confirm:`,
    });
    return isCancel(answer) ? "" : answer;
  };
}

/** The interactive production-confirm prompt: an `@clack/prompts` text field asking for the exact phrase. */
function productionPrompt(): () => Promise<string> {
  return async () => {
    const { isCancel, text } = await import("@clack/prompts");
    const answer = await text({
      message: `This writes to production. Type "${PRODUCTION_CONFIRM_PHRASE}" to confirm:`,
    });
    return isCancel(answer) ? "" : answer;
  };
}

export default defineCommand({
  meta: { name: "seed", description: "Seed an environment from your Zod-typed fixtures" },
  args: {
    env: { type: "string", default: "dev", description: "Target environment" },
    worker: { type: "string", description: "Seed one worker instead of every worker in apps/" },
    json: { type: "boolean", default: false, description: "Machine-readable output" },
    "dry-run": { type: "boolean", default: false, description: "Print the write plan; change nothing" },
    redo: {
      type: "boolean",
      default: false,
      description: "DESTRUCTIVE: drop every table and recreate the schema before seeding. All data is lost",
    },
    "confirm-reset": {
      type: "string",
      description: 'Unlock a non-dev reset non-interactively: "yes, i really want to reset <env>"',
    },
    yes: { type: "boolean", default: false, description: "Confirm a non-dev environment" },
    "confirm-production": {
      type: "string",
      description: `Unlock production non-interactively: "${PRODUCTION_CONFIRM_PHRASE}"`,
    },
  },
  run: ({ args }) =>
    withErrorReporting(args.json, async () => {
      const projectDir = process.cwd();
      const config = await loadProject(projectDir);
      const dryRun = args["dry-run"];
      const interactive = !args.json && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

      // Resolved once: the fan-out seeds these workers, and the audit emitter needs their capabilities
      // to know whether the project composes `audit` at all.
      const workers = await resolveWorkerScopes({
        projectDir,
        ...(args.worker !== undefined ? { worker: args.worker } : {}),
      });

      const report = await seedProject({
        projectDir,
        workers,
        env: args.env,
        includeExamples: config.seed?.includeExamples ?? false,
        dryRun,
        redo: args.redo,
        yes: args.yes,
        json: args.json,
        confirmProduction: args["confirm-production"],
        confirmReset: args["confirm-reset"],
        productionEnvironments: config.seed?.productionEnvironments,
        prompt: interactive ? productionPrompt() : undefined,
        promptReset: interactive ? resetPrompt(args.env) : undefined,
        audit: await buildSeedAudit(
          projectDir,
          args.env,
          workers.flatMap((worker) => worker.capabilities),
        ),
      });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ ...report })}\n`);
        return;
      }

      if (report.reset && report.reset.length > 0 && !dryRun) {
        process.stdout.write(`DESTRUCTIVE${saffron(".")} Every table in ${args.env} was dropped and recreated.\n`);
      }
      for (const entry of report.reset ?? []) {
        process.stdout.write(`${describeReset(entry, dryRun)}\n`);
      }
      if (report.workers.every((worker) => worker.sets.length === 0)) {
        process.stdout.write(`Nothing to seed for ${args.env}.\n`);
      }
      const width = Math.max(0, ...report.workers.map((worker) => worker.worker.length));
      for (const worker of report.workers) {
        process.stdout.write(describeWorker(worker, args.env, width));
      }
      if (dryRun) process.stdout.write("Dry run. Nothing written.\n");
      process.stdout.write(`${formatDone()}\n`);
    }),
});
