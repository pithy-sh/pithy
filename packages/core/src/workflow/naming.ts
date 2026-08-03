// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { InternalError } from "../error/pithyError";
import { MAX_CAPABILITY_JOB, NAMESPACE_LIMITS } from "../naming/limits";
import { assertValidProjectName, kebab } from "../naming/resource";
import { NAME_SEGMENT } from "../naming/segment";

/**
 * Every name a durable job answers to, in one module. The CLI writes these into a host worker's
 * resolved `wrangler.jsonc`, the provisioner deploys under them, and the dispatcher resolves
 * against them — so they are derived here once rather than formatted at three call sites that
 * would drift.
 *
 * The shape is the project-scoped rule from `@pithy-sh/core/src/naming/resource`:
 * **`<project>-<env>-<capability>`** for a host worker, and that plus `-<job>` for a Workflow.
 * Worker script names and Workflow names are both **account-scoped** in Cloudflare, so without the
 * project segment a second Pithy project's deploy does not share a name — it overwrites the first
 * project's running Worker. The project segment is what makes two projects in one account possible.
 *
 * Renaming a Workflow orphans every instance running under the old name, so these names are a
 * contract once anything is deployed. That is also why an over-long name is **refused rather than
 * truncated** here: a Workflow whose name silently changed shape is worse than a build error
 * telling you to shorten a capability name.
 */

/**
 * Cloudflare caps a Workflow name at 64 bytes.
 *
 * This is the number `WORKFLOW_DERIVED_PROJECT_NAME` comes from: a project is capped at whatever this
 * leaves after the longest environment and the longest `<capability>-<job>`, so the refusal lands at
 * `pithy init` rather than here, at the first deploy, with resources already provisioned.
 * `naming.test.ts` pins the two together.
 */
export const MAX_WORKFLOW_NAME_BYTES = NAMESPACE_LIMITS.workflow.maxLength;

/**
 * A Worker script name is **63**, not 64 — a different resource with a different number.
 *
 * Cloudflare allows 255 in general and 63 once a workers.dev subdomain is on. Pithy holds the 63:
 * it is the only value that stays true after an adopter enables workers.dev, and a script cannot be
 * renamed once anything points at it. The one-character gap between this and
 * {@link MAX_WORKFLOW_NAME_BYTES} is real; collapsing the two would loosen this one.
 */
export const MAX_WORKER_NAME_BYTES = NAMESPACE_LIMITS.worker.maxLength;

/**
 * Reject a segment that cannot legally appear in a Cloudflare resource name, attributed to its role.
 *
 * The shape is {@link NAME_SEGMENT}, the one segment rule — a Workflow name and a Worker script name
 * accept exactly what every other composed name does, so this reads the rule rather than restating it.
 */
function assertSegment(value: string, role: string): void {
  if (!NAME_SEGMENT.test(value)) {
    throw new InternalError({
      message: `Invalid ${role} "${value}" in a workflow name.`,
      action: "Use lowercase letters, digits, and single hyphens, starting with a letter.",
      detail: `A ${role} must match ${NAME_SEGMENT.source} to be a legal Cloudflare resource-name segment.`,
    });
  }
}

/**
 * Reject a composed name Cloudflare would refuse, naming the limit rather than letting the deploy fail.
 *
 * The limit is passed in because the two names this module composes have two different ones: a Workflow
 * gets 64, the Worker script hosting it gets 63.
 */
function assertLength(name: string, limit: number): string {
  if (new TextEncoder().encode(name).length > limit) {
    throw new InternalError({
      message: `The name "${name}" is longer than Cloudflare's ${limit}-byte limit.`,
      action: "Shorten the project, capability, or job name.",
    });
  }
  return name;
}

/**
 * Reject a `<capability>-<job>` tail longer than {@link MAX_CAPABILITY_JOB} — the tail
 * `MAX_PROJECT_NAME` was derived against.
 *
 * The project cap is only true while no registry declares a longer tail than the longest one that
 * existed when it was computed. A capability that would invalidate it fails here, at the name it
 * would deploy under, rather than quietly shortening the project name every existing project was
 * already accepted under — a change that cannot be made after the fact, because a project name is
 * stable forever once anything is provisioned.
 */
function assertCapabilityJob(capability: string, job: string): void {
  const tail = `${capability}-${job}`;
  if (tail.length > MAX_CAPABILITY_JOB) {
    throw new InternalError({
      message: `The job "${capability}/${job}" is ${tail.length} characters. A <capability>-<job> stops at ${MAX_CAPABILITY_JOB}.`,
      action: "Shorten the capability or job name.",
      detail: `MAX_PROJECT_NAME is derived against a ${MAX_CAPABILITY_JOB}-character tail. Raising MAX_CAPABILITY_JOB shortens every adopter's legal project name, and a provisioned project cannot be renamed.`,
    });
  }
}

/**
 * The `<project>-<env>` head every deployed name shares. The project is held to core's one project rule
 * — charset *and* length — because it comes from the adopter's `pithy.config.ts` and is the one segment
 * a human typed; the rest is author-controlled code and is asserted rather than mangled, so a bad
 * capability name is a build error, not a surprise.
 */
function head(project: string, env: string): string {
  assertValidProjectName(project);
  assertSegment(env, "environment");
  return `${kebab(project)}-${env}`;
}

/** The identity of a capability's deployment in one environment. */
export interface WorkflowHostNameParts {
  /** The project name — the root `pithy.config.ts` `name`, resolved by `requireProjectName` and never guessed. */
  project: string;
  /** The capability that owns the host worker (e.g. `email`). */
  capability: string;
  /** The deployment environment (e.g. `staging`). */
  env: string;
}

/** The identity of one durable job's Workflow in one environment. */
export interface WorkflowScriptNameParts extends WorkflowHostNameParts {
  /** The job within the capability (e.g. `send`). */
  job: string;
}

/**
 * The deployed name of one job's Workflow in one environment — `<project>-<env>-<capability>-<job>`,
 * e.g. `acme-staging-media-image-to-text`. This is what the CLI writes as the `name` of a
 * `workflows` entry, and what `CloudflareWorkflowsClient` addresses when triggering from outside
 * the Worker.
 *
 * Takes an options object rather than positional arguments deliberately: every part is a `string`,
 * so a swapped project and capability would type-check silently and deploy under a name teardown
 * could never find again.
 */
export function workflowScriptName(parts: WorkflowScriptNameParts): string {
  assertSegment(parts.capability, "capability");
  assertSegment(parts.job, "job");
  assertCapabilityJob(parts.capability, parts.job);
  return assertLength(`${head(parts.project, parts.env)}-${parts.capability}-${parts.job}`, MAX_WORKFLOW_NAME_BYTES);
}

/**
 * The deployed name of a capability's prebuilt host worker in one environment —
 * `<project>-<env>-<capability>`. Same options-object rationale as {@link workflowScriptName}.
 *
 * Held to {@link MAX_WORKER_NAME_BYTES}, one character tighter than the Workflow it hosts: this is a
 * Worker script name, and a workers.dev subdomain caps those at 63.
 */
export function workflowHostName(parts: WorkflowHostNameParts): string {
  assertSegment(parts.capability, "capability");
  return assertLength(`${head(parts.project, parts.env)}-${parts.capability}`, MAX_WORKER_NAME_BYTES);
}

/**
 * The dispatch key a caller passes to `c.var.workflows.trigger(...)` — `<capability>/<job>`.
 * Namespaced by capability so two capabilities may each own a job called `sweep`.
 *
 * **Deliberately not project-scoped.** This keys the in-Worker registry, and a Worker only ever
 * hosts one project's capabilities — adding the project would put a value every call site already
 * knows into a string every call site would have to thread. It is a dispatch key, not a
 * Cloudflare resource name, so it shares none of the account-flatness problem the names above have.
 */
export function workflowKey(capability: string, job: string): string {
  assertSegment(capability, "capability");
  assertSegment(job, "job");
  return `${capability}/${job}`;
}
