// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { defineCommand } from "citty";
import { z } from "zod";
import { type CliAuditEmit, createRemoteCliAudit, isRemoteEnv } from "../audit/cliAudit";
import { cloudflareClients } from "../cloudflare/clients";
import { type CloudflareAccountSelection, cloudflareEnv } from "../cloudflare/config";
import { withContract } from "../contract/commandContract";
import { renderDevSecretsNotes } from "../devSecrets/report";
import { type DevSecretsSeedReport, seedProjectDevSecrets } from "../devSecrets/seed";
import { DESTROY_RETAINED_DESCRIPTION, parseDestroyRetained } from "../migrations/confirm";
import { type ResetPreviewEntry, resolveWorkerScopes } from "../migrations/run";
import { DRY_RUN_ARG, PlanKey } from "../plan/plan";
import { loadProject, loadProjectCloudflare, requireProjectName } from "../project/config";
import { ENV_ARG, requireEnvironment } from "../project/environment";
import { seedDryRunPlan } from "../seed/dryRunPlan";
import { type SeedRunReport, type SeedWorkerReport, seedProject } from "../seed/run";
import { PRODUCTION_CONFIRM_PHRASE, resetConfirmPhrase } from "../seed/safety";
import { canceled, EXIT } from "../terminal/exitClass";
import { mayPrompt } from "../terminal/inputMode";
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

/**
 * One line per reset database: schema dropped and recreated, or (dry run) what would be (docs/CLI.md §3).
 * A database another environment binds is kept, and says so. A dry run names the retained tables a real
 * reset refuses to drop while they hold rows — the preview reads no backend, so it names them, not their
 * rows (#588).
 */
function describeReset(entry: ResetPreviewEntry, dryRun: boolean): string {
  if (entry.boundBy) return `Kept ${entry.database} (${entry.binding}): ${entry.boundBy.join(", ")} binds it too.`;
  const migrations = `${entry.migrations} migration${entry.migrations === 1 ? "" : "s"}`;
  if (!dryRun) return `Reset ${entry.database} (${entry.binding}): ${migrations} rolled back and reapplied.`;
  const retained = entry.retained.length > 0 ? ` Retained: ${entry.retained.join(", ")}.` : "";
  return `Would reset ${entry.database} (${entry.binding}): ${migrations}.${retained}`;
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
 * The order is the run's own: what the reset destroyed, then what each Worker wrote, then `Done.` — or,
 * on a dry run, `Dry run. Nothing written.` in its place, as every dry run ends (`docs/CLI.md` §1.2). The `DESTRUCTIVE.` banner leads a real reset only — a preview dropped nothing.
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

  lines.push(report.dryRun ? "Dry run. Nothing written." : formatDone());
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
  account: CloudflareAccountSelection | null,
): Promise<CliAuditEmit> {
  // Data-plane: a `dev` seed or reset only touches local Miniflare, so it is not audited — and asked before
  // the credentials are read, because another account's pair would refuse a run that uses none of it. By
  // then a real run has already written the dev secrets, so the refusal left it half done (#739).
  if (!isRemoteEnv(env)) return async () => {};
  const vars = cloudflareEnv({ account });
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = vars.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) return async () => {};
  return createRemoteCliAudit({
    projectDir,
    env,
    capabilities,
    clients: await cloudflareClients({ accountId, apiToken }),
    apiToken,
  });
}

/** The interactive reset-confirm prompt. Names the destruction plainly before asking for the phrase. */
export function resetPrompt(env: string): () => Promise<string> {
  return async () => {
    const { isCancel, text } = await import("@clack/prompts");
    const answer = await text({
      message: `DESTRUCTIVE: this drops every table in ${env} and all data is lost. Type "${resetConfirmPhrase(env)}" to confirm:`,
    });
    if (isCancel(answer)) canceled();
    return answer;
  };
}

/** The interactive production-confirm prompt: an `@clack/prompts` text field asking for the exact phrase. */
export function productionPrompt(): () => Promise<string> {
  return async () => {
    const { isCancel, text } = await import("@clack/prompts");
    const answer = await text({
      message: `This writes to production. Type "${PRODUCTION_CONFIRM_PHRASE}" to confirm:`,
    });
    if (isCancel(answer)) canceled();
    return answer;
  };
}

const Writes = (store: string) =>
  z.array(z.looseObject({}).describe(`One ${store} write.`)).describe(`The set's ${store} writes.`);

/** `pithy seed --json`. `docs/commands/seed.md`. */
const SeedPayload = z
  .object({
    command: z.literal("seed").describe('`"seed"`.'),
    env: z.string().describe("The environment seeded."),
    dryRun: z.boolean().describe("Whether the plan was computed and nothing written."),
    workers: z
      .array(
        z
          .object({
            worker: z.string().describe("The Worker's name."),
            sets: z
              .array(
                z
                  .object({
                    name: z.string().describe("The set's composed key."),
                    d1: Writes("d1"),
                    kv: Writes("kv"),
                    r2: Writes("r2"),
                    media: Writes("media"),
                  })
                  .describe("One seed set's outcome."),
              )
              .describe("The per-set outcome, in run order."),
            skippedByEnv: z
              .array(z.string().describe("A set."))
              .describe("The sets this environment disallows — surfaced, never silently dropped."),
            shared: z
              .array(z.string().describe("A set."))
              .describe("The sets an earlier Worker already wrote to the same store."),
          })
          .describe("One Worker's outcome."),
      )
      .describe("The per-Worker outcome, in fan-out order."),
    reset: z
      .array(
        z
          .object({
            database: z.string().describe("The database name."),
            binding: z.string().describe("Its D1 binding."),
            migrations: z.number().int().describe("How many migrations the reset reverses and reapplies."),
            retained: z.array(z.string().describe("A table.")).describe("The retained tables it carries."),
            boundBy: z
              .array(z.string().describe("An environment."))
              .optional()
              .describe("The other environments binding it. Present only when the reset keeps it."),
          })
          .describe("One database the reset reached."),
      )
      .optional()
      .describe("Present only with `--redo`: one entry per database whose schema was, or would be, reset."),
    devSecrets: z
      .looseObject({})
      .nullable()
      .describe("What the dev-secrets pass wrote and refused. `null` on a dry run and outside `dev`."),
    plan: PlanKey,
  })
  .describe("What `pithy seed` loaded, or would.");

export default withContract(
  defineCommand({
    meta: { name: "seed", description: "Seed an environment from your Zod-typed fixtures" },
    args: {
      env: ENV_ARG,
      worker: { type: "string", description: "Seed one worker instead of every worker in apps/" },
      json: { type: "boolean", default: false, description: "Machine-readable output" },
      "dry-run": DRY_RUN_ARG,
      redo: {
        type: "boolean",
        default: false,
        description:
          "DESTRUCTIVE: drop every table and recreate the schema before seeding. All data is lost. Refuses while retained tables hold rows",
      },
      "confirm-reset": {
        type: "string",
        description: 'Unlock a non-dev reset non-interactively: "yes, i really want to reset <env>"',
      },
      "destroy-retained": { type: "string", description: DESTROY_RETAINED_DESCRIPTION },
      yes: { type: "boolean", default: false, description: "Confirm a non-dev environment" },
      "confirm-production": {
        type: "string",
        description: `Unlock production non-interactively: "${PRODUCTION_CONFIRM_PHRASE}"`,
      },
      host: {
        type: "string",
        description:
          "The host a prepared set's origin is built from, e.g. preview.example.com. Defaults to the Worker's own address",
      },
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const env = requireEnvironment(args.env);
        const projectDir = process.cwd();
        const config = await loadProject(projectDir);
        // The account this project belongs to, resolved from the config just loaded. Used by the seed run
        // itself and by the audit emitter — one answer, so the two can never disagree about whose D1 was
        // written and whose trail records it (#234).
        const account = loadProjectCloudflare(config) ?? null;
        const dryRun = args["dry-run"];
        const destroyRetained = parseDestroyRetained(args["destroy-retained"]);
        const interactive = mayPrompt(args.json);

        // Resolved once: the fan-out seeds these workers, and the audit emitter needs their capabilities
        // to know whether the project composes `audit` at all.
        const workers = await resolveWorkerScopes({
          projectDir,
          env,
          ...(args.worker !== undefined ? { worker: args.worker } : {}),
        });

        // Dev secrets first, and only for `dev`. The dev secrets file is machine-local — there is no staging
        // copy of it, and a deployed environment's secrets come from `pithy secrets create` through the
        // manager Workflow. Before the fixtures, because a fixture that signs a token or a link needs the
        // key that signs it to already be in the store.
        //
        // Never fatal to a `--dry-run`, and never run by one: a dry run writes nothing, and seeding a
        // secret is a write.
        const devSecrets =
          env === "dev" && !dryRun
            ? await seedProjectDevSecrets({ projectDir })
            : (null as DevSecretsSeedReport | null);
        if (devSecrets && !args.json) {
          for (const line of renderDevSecretsNotes(devSecrets)) process.stdout.write(`${line}\n`);
        }
        // A `.dev.vars` pithy did not generate is never overwritten and never merged (#154) — so a Worker
        // that was supposed to get one has not got one, and that is a failed run. The lines above already
        // name the file and point at `.dev.vars.local`; this is what makes a script notice. Not a throw:
        // the fixtures below are the rest of the run and they are worth doing.
        if (devSecrets && (devSecrets.devVarsRefused ?? []).length > 0) process.exitCode = EXIT.failed;

        const report = await seedProject({
          projectDir,
          // `requireProjectName`, never `resolveProjectName`: a fixture can mint Images/Stream assets, and
          // this name is the owner stamped into their metadata — the only handle a later sweep has on them.
          project: requireProjectName(config),
          // The account this project names, or `null` when it names none. Not the default credentials file:
          // a non-`dev` seed writes rows into a real D1 and objects into a real R2 (#234).
          account,
          workers,
          env,
          includeExamples: config.seed?.includeExamples ?? false,
          dryRun,
          redo: args.redo,
          yes: args.yes,
          json: args.json,
          confirmProduction: args["confirm-production"],
          confirmReset: args["confirm-reset"],
          ...(destroyRetained !== undefined ? { destroyRetained } : {}),
          productionEnvironments: config.seed?.productionEnvironments,
          // The origin a prepared set is handed. Absent, each Worker's own address: its pinned port in `dev`, its
          // declared domain in a declared environment, its `workers.dev` origin on a feature (#643).
          ...(args.host !== undefined ? { host: args.host } : {}),
          prompt: interactive ? productionPrompt() : undefined,
          promptReset: interactive ? resetPrompt(env) : undefined,
          audit: await buildSeedAudit(
            projectDir,
            env,
            workers.flatMap((worker) => worker.capabilities),
            account,
          ),
        });

        if (args.json) {
          const plan = report.dryRun ? seedDryRunPlan(report) : undefined;
          process.stdout.write(`${formatJsonLine({ ...report, devSecrets, plan })}\n`);
          return;
        }

        process.stdout.write(`${renderSeedText(report)}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: SeedPayload,
    mutates: true,
    idempotent: true,
    needsNetwork: true,
  },
);
