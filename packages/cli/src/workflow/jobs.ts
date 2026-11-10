// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { workerDirOf } from "@pithy-sh/core/src/cli/command";
import { fromZodError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { composeWorkflows } from "@pithy-sh/core/src/workflow/register";
import type { RegisteredWorkflow, WorkflowRegistry } from "@pithy-sh/core/src/workflow/spec";
import { z } from "zod";
import { provisionHostOwner } from "../capabilities/hostRegistry";
import type { WorkflowConfig } from "../project/appWorkflows";
import { readOptionalWranglerConfig } from "../project/wrangler";

/**
 * The job a `pithy workflow` command names, out of the registry its Worker composes: by its `<capability>/<job>`
 * key, or by its bare job name when exactly one capability declares a job by that name.
 */
export function findJob(registry: WorkflowRegistry, name: string, worker: string): RegisteredWorkflow {
  const byKey = registry[name];
  if (byKey) return byKey;
  const matches = Object.values(registry).filter((entry) => entry.job === name);
  const [only] = matches;
  if (matches.length === 1 && only) return only;
  if (matches.length > 1) {
    throw new ValidationError({
      message: `"${name}" is a job in more than one capability.`,
      action: `Name it by its key: ${matches
        .map((entry) => entry.key)
        .sort()
        .join(", ")}.`,
    });
  }
  const known = Object.keys(registry).sort();
  throw new ValidationError({
    message: `${worker} declares no Workflow job "${name}".`,
    action:
      known.length === 0
        ? `${worker} composes no capability that declares a Workflow.`
        : `Pick one of: ${known.join(", ")}.`,
  });
}

/**
 * `--params`, parsed as JSON and then through the job's own `params` schema, so a payload the Workflow would
 * refuse is refused here with the schema's message. No `--params` is `{}`, which a schema of defaults fills in.
 */
export function parseJobParams(entry: RegisteredWorkflow, raw: string | undefined): unknown {
  let value: unknown = {};
  if (raw !== undefined) {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ValidationError({
        message: "--params is not JSON.",
        action: `Pass one JSON value, such as --params '{"backfill":true}'.`,
      });
    }
  }
  const parsed = entry.spec.params.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`))
    .join("; ");
  throw fromZodError(parsed.error, {
    message: `--params does not fit ${entry.key}: ${issues}.`,
    action: "Correct --params to match the job's params schema.",
  });
}

/** Cloudflare's rule for an instance id. */
const INSTANCE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** `--id`, held to Cloudflare's rule for an instance id. */
export function parseInstanceId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (INSTANCE_ID.test(raw)) return raw;
  throw new ValidationError({
    message: "--id must be 1 to 100 letters, digits, dashes or underscores.",
    action: "Pass an id such as --id backfill-2026-11-09, or leave it off.",
  });
}

/** What naming a job's Workflow needs from its Worker. */
export interface JobWorker {
  /** The Worker's composed capabilities, its app among them. */
  capabilities: readonly Capability[];
  /** The discovered Worker: its directory, and the bindings it owns. */
  target: { dir: string; ownBindings?: readonly string[] };
  /** The `workflows` entries its `wrangler.jsonc` binds in the environment, from {@link boundWorkflows}. */
  bound?: readonly BoundWorkflow[];
}

/** One `workflows` entry of a Worker's environment stanza: the binding, and the deployed Workflow it names. */
export interface BoundWorkflow {
  binding: string;
  name: string;
}

/** The `workflows` entries `env.<env>` of the Worker's `wrangler.jsonc` binds. None when it has no config. */
export async function boundWorkflows(dir: string, env: string): Promise<BoundWorkflow[]> {
  const config = (await readOptionalWranglerConfig(dir)) as WorkflowConfig | null;
  return (config?.env?.[env]?.workflows ?? []).map(({ binding, name }) => ({ binding, name }));
}

/** What {@link jobWorkflowName} names. */
export interface JobWorkflowNameParts {
  /** The project name, from `requireProjectName`. */
  project: string;
  /** The environment the Workflow is deployed in. */
  env: string;
  /** The job. */
  entry: RegisteredWorkflow;
  /** The Worker that composes it. */
  worker: JobWorker;
}

/**
 * The deployed name of a job's Workflow in one environment: `<project>-<env>-<capability>-<job>`, with the Worker's
 * own host in the name when that Worker owns what its capability's host binds.
 *
 * A job with no `className` runs in no host Pithy writes: the adopter's Worker exports its class and carries a
 * hand-written `workflows` entry for it. Its name is that entry's, by binding, and without one it is the owner-less
 * `<project>-<env>-<capability>-<job>` the capability's docs tell the adopter to write.
 */
export function jobWorkflowName(parts: JobWorkflowNameParts): string {
  const names = resourceNames(parts.project).env(parts.env);
  if (parts.entry.spec.className === undefined) {
    const written = parts.worker.bound?.find((one) => one.binding === parts.entry.spec.binding);
    return written?.name ?? names.workflow(parts.entry.capability, parts.entry.job);
  }
  const capability = parts.worker.capabilities.find((one) => one.name === parts.entry.capability);
  const owner = capability ? provisionHostOwner(capability, parts.worker.target)?.worker : undefined;
  return names.workflow(parts.entry.capability, parts.entry.job, owner);
}

/** One job a Worker composes, as `pithy workflow list` reports it. */
export const JobRow = z
  .object({
    worker: z.string().describe("The Worker that composes it, by its `apps/` directory."),
    key: z.string().describe("The job's `<capability>/<job>` key."),
    capability: z.string().describe("The capability that declares it: a kit capability, or the Worker's app."),
    job: z.string().describe("The job name."),
    binding: z.string().describe("The Workflow binding the Worker reaches it by."),
    schedule: z.string().nullable().describe("Its cron, or `null` for a job that runs only when triggered."),
    workflow: z.string().describe("Its deployed Workflow name in the environment."),
  })
  .describe("One Workflow job a Worker composes.");
export type JobRow = z.infer<typeof JobRow>;

/** Every job each Worker composes, Worker by Worker, each Worker's jobs by key. */
export function jobRows(
  workers: readonly JobWorker[],
  parts: Omit<JobWorkflowNameParts, "entry" | "worker">,
): JobRow[] {
  return workers.flatMap((worker) =>
    Object.values(composeWorkflows(worker.capabilities))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((entry) => ({
        worker: workerDirOf(worker.target),
        key: entry.key,
        capability: entry.capability,
        job: entry.job,
        binding: entry.spec.binding,
        schedule: entry.spec.schedule ?? null,
        workflow: jobWorkflowName({ ...parts, entry, worker }),
      })),
  );
}
