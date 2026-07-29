import { InternalError } from "../error/pithyError";

/**
 * Every name a durable job answers to, in one module. The CLI writes these into a host worker's
 * resolved `wrangler.jsonc`, the provisioner deploys under them, and the dispatcher resolves
 * against them — so they are derived here once rather than formatted at three call sites that
 * would drift.
 *
 * The shape is the one already deployed: `pithy-email-send`, `pithy-media-image-to-text`, each
 * suffixed with its environment. Renaming a Workflow orphans every instance running under the old
 * name, so the existing wire names are the contract, not a starting point.
 */

/** The namespace every Pithy-provided Cloudflare resource carries, so nothing collides with an adopter's own. */
const PREFIX = "pithy";

/** Cloudflare caps a Workflow name — and a Worker script name — at 64 bytes. */
export const MAX_WORKFLOW_NAME_BYTES = 64;

/** One name segment: lowercase, digits, and inner hyphens. Matches what Cloudflare accepts for both resources. */
const SEGMENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Reject a segment that cannot legally appear in a Cloudflare resource name, attributed to its role. */
function assertSegment(value: string, role: string): void {
  if (!SEGMENT.test(value)) {
    throw new InternalError({
      message: `Invalid ${role} "${value}" in a workflow name.`,
      action: "Use lowercase letters, digits, and single hyphens, starting with a letter.",
      detail: `A ${role} must match ${SEGMENT.source} to be a legal Cloudflare resource-name segment.`,
    });
  }
}

/** Reject a composed name Cloudflare would refuse, naming the limit rather than letting the deploy fail. */
function assertLength(name: string): string {
  if (new TextEncoder().encode(name).length > MAX_WORKFLOW_NAME_BYTES) {
    throw new InternalError({
      message: `The name "${name}" is longer than Cloudflare's ${MAX_WORKFLOW_NAME_BYTES}-byte limit.`,
      action: "Shorten the capability or job name.",
    });
  }
  return name;
}

/**
 * The deployed name of one job's Workflow in one environment — `pithy-<capability>-<job>-<env>`,
 * e.g. `pithy-media-image-to-text-staging`. This is what the CLI writes as the `name` of a
 * `workflows` entry, and what `CloudflareWorkflowsClient` addresses when triggering from outside
 * the Worker.
 */
export function workflowScriptName(capability: string, job: string, env: string): string {
  assertSegment(capability, "capability");
  assertSegment(job, "job");
  assertSegment(env, "environment");
  return assertLength(`${PREFIX}-${capability}-${job}-${env}`);
}

/**
 * The deployed name of a capability's prebuilt host worker in one environment —
 * `pithy-<capability>-<env>`. Matches the names email and secrets already deploy under, so the
 * generic helper and the two hand-written ones cannot disagree.
 */
export function workflowHostName(capability: string, env: string): string {
  assertSegment(capability, "capability");
  assertSegment(env, "environment");
  return assertLength(`${PREFIX}-${capability}-${env}`);
}

/**
 * The dispatch key a caller passes to `c.var.workflows.trigger(...)` — `<capability>/<job>`.
 * Namespaced by capability so two capabilities may each own a job called `sweep`.
 */
export function workflowKey(capability: string, job: string): string {
  assertSegment(capability, "capability");
  assertSegment(job, "job");
  return `${capability}/${job}`;
}
