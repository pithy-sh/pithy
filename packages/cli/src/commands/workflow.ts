// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { pithyCommand, workerDirOf } from "@pithy-sh/core/src/cli/command";
import { composeWorkflows } from "@pithy-sh/core/src/workflow/register";
import { defineCommand } from "citty";
import { z } from "zod";
import { cloudflareWorkflows } from "../cloudflare/clients";
import { commandCredentials } from "../cloudflare/commandCredentials";
import { withContract } from "../contract/commandContract";
import { DRY_RUN_ARG, emptyPlan, type Plan, PlanKey } from "../plan/plan";
import { resolveSingleWorkerFor, resolveWorkersFor } from "../project/composeFor";
import { loadProject, loadProjectEnvironments, projectCloudflareAccount, requireProjectName } from "../project/config";
import { requireManagedEnvironment } from "../project/environment";
import { canceled } from "../terminal/exitClass";
import { mayPrompt } from "../terminal/inputMode";
import { formatDone, formatJsonLine, withErrorReporting } from "../terminal/output";
import { assertTriggerConfirmed, triggerConfirmPhrase } from "../workflow/confirm";
import {
  boundWorkflows,
  findJob,
  JobRow,
  jobRows,
  jobWorkflowName,
  parseInstanceId,
  parseJobParams,
} from "../workflow/jobs";
import { jobStatus, triggerJob } from "../workflow/run";

/**
 * `pithy workflow trigger | list | status` — start a Workflow a Worker composes by hand, list them, and follow one
 * instance, through the deployed Workflow in an environment. A job is named by its `<capability>/<job>` key, or by
 * its bare name when one capability alone declares it.
 */

const ENV = {
  type: "string",
  description: "The deployed environment: staging, prod, or one declared in pithy.config.ts",
} as const;

const WORKER = {
  type: "string",
  description: "The Worker that composes the job (default: the project's only worker)",
} as const;

const JSON_ARG = { type: "boolean", default: false, description: "Machine-readable output" } as const;

/** The project, the environment and the job's Worker, resolved in the order their refusals cost least. */
async function target(args: { env?: string; worker?: string }) {
  const projectDir = process.cwd();
  const config = await loadProject(projectDir);
  const project = requireProjectName(config);
  const env = requireManagedEnvironment(args.env ?? "", loadProjectEnvironments(config));
  const resolved = await resolveSingleWorkerFor(env, {
    projectDir,
    ...(args.worker === undefined ? {} : { worker: args.worker }),
  });
  const worker = { ...resolved, bound: await boundWorkflows(resolved.target.dir, env) };
  return { projectDir, config, project, env, worker };
}

/** The account's Workflows, from this project's Cloudflare credentials. */
async function accountWorkflows(projectDir: string) {
  return cloudflareWorkflows(commandCredentials(await projectCloudflareAccount(projectDir)));
}

/** The interactive production prompt: the exact, environment-named phrase. */
export function triggerPrompt(env: string): () => Promise<string> {
  return async () => {
    const { isCancel, text } = await import("@clack/prompts");
    const answer = await text({
      message: `This starts a Workflow in ${env}. Type "${triggerConfirmPhrase(env)}" to confirm:`,
    });
    if (isCancel(answer)) canceled();
    return answer;
  };
}

/** `pithy workflow trigger --dry-run`, as the one plan every dry run shares: one instance it would start. */
export function triggerPlan(worker: string, workflow: string, instanceId: string | null): Plan {
  return {
    ...emptyPlan(),
    data: [{ worker, store: "workflow", target: workflow, count: 1, action: "write" }],
    notes: [
      instanceId === null
        ? "Cloudflare picks the instance id when the instance starts."
        : `The instance would be named ${instanceId}.`,
    ],
  };
}

const WorkflowTriggerPayload = z
  .object({
    command: z.literal("workflow trigger").describe('`"workflow trigger"`.'),
    env: z.string().describe("The environment the Workflow runs in."),
    worker: z.string().describe("The Worker that composes the job, by its `apps/` directory."),
    job: z.string().describe("The job's `<capability>/<job>` key."),
    workflow: z.string().describe("The deployed Workflow the instance runs under."),
    instanceId: z
      .string()
      .nullable()
      .describe("The instance id. `null` only under `--dry-run` when Cloudflare would pick it."),
    dryRun: z.boolean().describe("Whether this was `--dry-run`. Nothing was started when it is `true`."),
    plan: PlanKey,
  })
  .describe("What `pithy workflow trigger` started.");

const trigger = withContract(
  defineCommand({
    meta: { name: "trigger", description: "Start a Workflow a Worker composes, with validated params" },
    args: {
      job: { type: "positional", required: true, description: "The job: its <capability>/<job> key, or its bare name" },
      env: ENV,
      worker: WORKER,
      params: { type: "string", description: `The instance params, as JSON: '{"backfill":true}' (default: {})` },
      id: { type: "string", description: "Name the instance (default: the job's instanceId, else Cloudflare's)" },
      confirm: {
        type: "string",
        description: 'Unlock a production environment non-interactively: "yes, i really want to trigger <env>"',
      },
      "dry-run": DRY_RUN_ARG,
      json: JSON_ARG,
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const { projectDir, config, project, env, worker } = await target(args);
        const workerDir = workerDirOf(worker.target);
        const entry = findJob(composeWorkflows(worker.capabilities), args.job, workerDir);
        const params = parseJobParams(entry, args.params);
        const id = parseInstanceId(args.id);
        const workflow = jobWorkflowName({ project, env, entry, worker });
        const dryRun = args["dry-run"];
        if (!dryRun) {
          const interactive = mayPrompt(args.json);
          await assertTriggerConfirmed({
            env,
            json: !interactive,
            ...(args.confirm === undefined ? {} : { confirmPhrase: args.confirm }),
            ...(interactive ? { prompt: triggerPrompt(env) } : {}),
            ...(config.seed?.productionEnvironments === undefined
              ? {}
              : { productionEnvironments: config.seed.productionEnvironments }),
          });
        }
        const workflows = await accountWorkflows(projectDir);
        const follow = (instance: string) =>
          pithyCommand("workflow status", {
            args: [entry.key, instance],
            flags: { "--env": env, "--worker": workerDir },
          });
        const outcome = await triggerJob({
          entry,
          workflow,
          params,
          ...(id === undefined ? {} : { id }),
          dryRun,
          workflows,
          follow,
        });

        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({
              command: "workflow trigger",
              env,
              worker: workerDir,
              job: entry.key,
              workflow,
              instanceId: outcome.instanceId,
              dryRun,
              plan: dryRun ? triggerPlan(workerDir, workflow, outcome.instanceId) : undefined,
            })}\n`,
          );
          return;
        }
        if (dryRun) {
          process.stdout.write(
            `Would start ${entry.key} in ${env}, as ${workflow}${outcome.instanceId === null ? "." : `, instance ${outcome.instanceId}.`}\n`,
          );
          process.stdout.write("Dry run. Nothing started.\n");
          return;
        }
        const instance = outcome.instanceId as string;
        process.stdout.write(`Started ${entry.key} in ${env}, as ${workflow}.\n`);
        process.stdout.write(`Instance ${instance}. Follow it with ${follow(instance)}.\n`);
        process.stdout.write(`${formatDone()}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: WorkflowTriggerPayload,
    mutates: true,
    idempotent: false,
    needsNetwork: true,
  },
);

const WorkflowListPayload = z
  .object({
    command: z.literal("workflow list").describe('`"workflow list"`.'),
    env: z.string().describe("The environment the Workflow names are for."),
    jobs: z.array(JobRow).describe("Every job each Worker composes, Worker by Worker."),
  })
  .describe("What `pithy workflow list` found.");

const list = withContract(
  defineCommand({
    meta: { name: "list", description: "List every Workflow job the Workers compose, with its deployed name" },
    args: {
      env: ENV,
      worker: { type: "string", description: "List one Worker's jobs (default: every Worker's)" },
      json: JSON_ARG,
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const projectDir = process.cwd();
        const config = await loadProject(projectDir);
        const project = requireProjectName(config);
        const env = requireManagedEnvironment(args.env ?? "", loadProjectEnvironments(config));
        const workers = await resolveWorkersFor(env, {
          projectDir,
          ...(args.worker === undefined ? {} : { worker: args.worker }),
        });
        const bound = await Promise.all(
          workers.map(async (worker) => ({ ...worker, bound: await boundWorkflows(worker.target.dir, env) })),
        );
        const jobs = jobRows(bound, { project, env });

        if (args.json) {
          process.stdout.write(`${formatJsonLine({ command: "workflow list", env, jobs })}\n`);
          return;
        }
        if (jobs.length === 0) {
          process.stdout.write("No Worker composes a Workflow.\n");
          return;
        }
        for (const row of jobs) {
          const schedule = row.schedule === null ? "on trigger" : `cron ${row.schedule}`;
          process.stdout.write(`${row.worker}  ${row.key}  ${row.workflow}  ${schedule}\n`);
        }
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: WorkflowListPayload,
    mutates: false,
    idempotent: true,
    needsNetwork: false,
  },
);

const WorkflowStatusPayload = z
  .object({
    command: z.literal("workflow status").describe('`"workflow status"`.'),
    env: z.string().describe("The environment the Workflow runs in."),
    worker: z.string().describe("The Worker that composes the job, by its `apps/` directory."),
    job: z.string().describe("The job's `<capability>/<job>` key."),
    workflow: z.string().describe("The deployed Workflow the instance runs under."),
    instanceId: z.string().describe("The instance id."),
    status: z
      .string()
      .describe(
        "The instance's lifecycle state, as Cloudflare reports it: `queued`, `running`, `paused`, `waiting`, `complete`, `errored`, `terminated` and the rest of its set.",
      ),
    output: z.unknown().optional().describe("The Workflow's return value. Present once `status` is `complete`."),
    error: z
      .string()
      .nullable()
      .describe("Why it failed: the failed step's text, else the instance's own. `null` when nothing failed."),
    failedStep: z.string().nullable().describe("The name of the step that failed. `null` when none did."),
  })
  .describe("What one Workflow instance reports.");

const status = withContract(
  defineCommand({
    meta: { name: "status", description: "Report one Workflow instance: its state, output and failure" },
    args: {
      job: { type: "positional", required: true, description: "The job: its <capability>/<job> key, or its bare name" },
      instance: { type: "positional", required: true, description: "The instance id the trigger printed" },
      env: ENV,
      worker: WORKER,
      json: JSON_ARG,
    },
    run: ({ args }) =>
      withErrorReporting(args.json, async () => {
        const { projectDir, project, env, worker } = await target(args);
        const workerDir = workerDirOf(worker.target);
        const entry = findJob(composeWorkflows(worker.capabilities), args.job, workerDir);
        const workflow = jobWorkflowName({ project, env, entry, worker });
        const report = await jobStatus({
          workflow,
          instanceId: args.instance,
          workflows: await accountWorkflows(projectDir),
        });

        if (args.json) {
          process.stdout.write(
            `${formatJsonLine({
              command: "workflow status",
              env,
              worker: workerDir,
              job: entry.key,
              workflow,
              instanceId: args.instance,
              status: report.status,
              output: report.output,
              error: report.error,
              failedStep: report.failedStep,
            })}\n`,
          );
          return;
        }
        process.stdout.write(`${entry.key} ${args.instance} in ${env}: ${report.status}.\n`);
        if (report.error !== null) {
          process.stdout.write(
            `${report.failedStep === null ? "Failed" : `Step ${report.failedStep} failed`}: ${report.error}\n`,
          );
        }
        if (report.output !== undefined) process.stdout.write(`Output: ${JSON.stringify(report.output)}\n`);
      }),
  }),
  {
    output: "document",
    schemaVersion: 1,
    payload: WorkflowStatusPayload,
    mutates: false,
    idempotent: true,
    needsNetwork: true,
  },
);

export default defineCommand({
  meta: { name: "workflow", description: "Start a Workflow by hand, list them, and follow an instance" },
  subCommands: { trigger, list, status },
});
