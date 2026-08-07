// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { defineCommand } from "citty";
import { type CliAuditEmit, createRemoteCliAudit } from "../audit/cliAudit";
import { renderDevSecretsNotes } from "../devSecrets/report";
import { type DevSecretsSeedReport, seedProjectDevSecrets } from "../devSecrets/seed";
import { type ResetPreviewEntry, resolveWorkerScopes } from "../migrations/run";
import { loadProject, requireProjectName } from "../project/config";
import { ENV_ARG, requireEnvironment } from "../project/environment";
import { type SeedRunReport, type SeedWorkerReport, seedProject } from "../seed/run";
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
function describeWorker(worker: SeedWorkerReport, env: string, width: number): string[] {
  const name = worker.worker.padEnd(width);
  const lines: string[] = [];
  for (const key of worker.skippedByEnv) lines.push(`${name}  skipped ${key}: not allowed in ${env}.`);
  for (const key of worker.shared) lines.push(`${name}  ${key}: already seeded by another worker.`);
  for (const set of worker.sets) lines.push(`${name}  ${describeSet(set)}`);
  return lines;
}

/**
 * The whole human report for one seed run, as a pure function of its result — the peer of
 * `renderDoctorText`, and for the same reason: `docs/CLI.md` §8.2 and §8.5 paste these transcripts, so
 * they have to be a value a test can render and compare against the document (`seedDocs.test.ts`).
 * Assembling them across inline `process.stdout.write` calls made that impossible, and the blocks
 * rotted. The command writes what this returns, plus the trailing newline.
 *
 * The order is the run's own: what the reset destroyed, then what each Worker wrote, then the dry-run
 * reminder, then `Done.` The `DESTRUCTIVE.` banner leads a real reset only — a preview dropped nothing.
 */
export function renderSeedText(report: SeedRunReport): string {
  const reset = report.reset ?? [];
  const lines: string[] = [];

  if (reset.length > 0 && !report.dryRun) {
    lines.push(`DESTRUCTIVE${saffron(".")} Every table in ${report.env} was dropped and recreated.`);
  }
  for (const entry of reset) lines.push(describeReset(entry, report.dryRun));

  if (report.workers.every((worker) => worker.sets.length === 0)) {
    lines.push(`Nothing to seed for ${report.env}.`);
  }
  // One column width across the whole fan-out, so every Worker's lines align into one list.
  const width = Math.max(0, ...report.workers.map((worker) => worker.worker.length));
  for (const worker of report.workers) lines.push(...describeWorker(worker, report.env, width));

  if (report.dryRun) lines.push("Dry run. Nothing written.");
  lines.push(formatDone());
  return lines.join("\n");
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
    env: ENV_ARG,
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
      const env = requireEnvironment(args.env);
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

      // Dev secrets first, and only for `dev`. `.dev.secrets.jsonc` is a local file — there is no staging
      // copy of it, and a deployed environment's secrets come from `pithy secrets create` through the
      // manager Workflow. Before the fixtures, because a fixture that signs a token or a link needs the
      // key that signs it to already be in the store.
      //
      // Never fatal to a `--dry-run`, and never run by one: a dry run writes nothing, and seeding a
      // secret is a write.
      const devSecrets =
        env === "dev" && !dryRun ? await seedProjectDevSecrets({ projectDir }) : (null as DevSecretsSeedReport | null);
      if (devSecrets && !args.json) {
        for (const line of renderDevSecretsNotes(devSecrets)) process.stdout.write(`${line}\n`);
      }

      const report = await seedProject({
        projectDir,
        // `requireProjectName`, never `resolveProjectName`: a fixture can mint Images/Stream assets, and
        // this name is the owner stamped into their metadata — the only handle a later sweep has on them.
        project: requireProjectName(config),
        workers,
        env,
        includeExamples: config.seed?.includeExamples ?? false,
        dryRun,
        redo: args.redo,
        yes: args.yes,
        json: args.json,
        confirmProduction: args["confirm-production"],
        confirmReset: args["confirm-reset"],
        productionEnvironments: config.seed?.productionEnvironments,
        prompt: interactive ? productionPrompt() : undefined,
        promptReset: interactive ? resetPrompt(env) : undefined,
        audit: await buildSeedAudit(
          projectDir,
          env,
          workers.flatMap((worker) => worker.capabilities),
        ),
      });

      if (args.json) {
        process.stdout.write(`${formatJsonLine({ ...report, devSecrets })}\n`);
        return;
      }

      process.stdout.write(`${renderSeedText(report)}\n`);
    }),
});
