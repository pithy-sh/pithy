import type { z } from "zod";

/**
 * The durable-job seam. A capability declares the Cloudflare Workflows it owns as a map of
 * job name → {@link WorkflowSpec}; `createBackend` collects every capability's map into one
 * registry, derives each spec's binding so a missing one fails at boot, and serves a typed
 * dispatcher on `c.var.workflows`.
 *
 * The spec is the single description of a job. The CLI reads it to write the host worker's
 * `workflows` array and its cron triggers; the dispatcher reads it to validate params and find
 * the binding; `naming.ts` reads it to resolve the per-environment script name. One declaration,
 * no drift between the wrangler config, the provisioner, and the call site.
 */

/**
 * The minimal structural shape of a Cloudflare Workflow binding: enough to start an instance,
 * and nothing more. Typed structurally rather than against `Workflow<P>` from
 * `@cloudflare/workers-types` so core gains no runtime dependency and a test injects a plain
 * object literal — the same posture `@pithy-sh/media` already takes for its AI binding.
 */
export interface WorkflowBinding {
  /** Start a new instance. `params` is the validated payload the Workflow receives as `event.payload`. */
  create(options?: { id?: string; params?: unknown }): Promise<unknown>;
}

/**
 * One durable job a capability registers. Keyed in {@link WorkflowSpecMap} by its job name, which
 * is also the second segment of the `<capability>/<job>` dispatch key.
 */
export interface WorkflowSpec<Params extends z.ZodType = z.ZodType> {
  /**
   * The binding name the Workflow is bound to in the Worker env (e.g. `MEDIA_IMAGE_TO_TEXT`).
   * `createBackend` derives a `workflow` {@link BindingSpec} from it, so a job whose binding is
   * absent surfaces as a startup failure rather than a silent no-op at dispatch time.
   */
  binding: string;
  /**
   * The instance parameters, validated **at dispatch** — before the binding is touched. A malformed
   * trigger therefore fails at the call site with `core/invalid_workflow_params`, rather than inside
   * a running instance where the only signal is a failed step and a retry budget burning down.
   */
  params: Params;
  /**
   * A cron expression. Present means the CLI writes a `triggers.crons` entry into the host worker's
   * resolved `wrangler.jsonc` and `createEntrypoint` routes the `scheduled` event here. Absent means
   * dispatch-only. A scheduled job stays manually triggerable either way — a backfill nobody can run
   * on demand is untestable.
   */
  schedule?: string;
  /**
   * The exported `WorkflowEntrypoint` subclass in the host worker that runs this job — the
   * `class_name` the CLI writes into the host's `workflows` array. Omit only for a job whose host
   * config is hand-maintained.
   */
  className?: string;
  /**
   * Treat the derived binding as optional, so a project that has not provisioned the host worker
   * still boots. Defaults to false. `@pithy-sh/media` sets it: its enrichment Workflows appear only
   * once `pithy media provision` has run, and the app must serve every other route until then.
   */
  optional?: boolean;
}

/** A capability's durable jobs: job name → {@link WorkflowSpec}. The peer of `databases` and `kvNamespaces`. */
export type WorkflowSpecMap = Record<string, WorkflowSpec>;

/**
 * A spec resolved against the capability that declared it — what the registry holds and the
 * dispatcher looks up. `key` is the `<capability>/<job>` dispatch key.
 */
export interface RegisteredWorkflow {
  /** The dispatch key, `<capability>/<job>`. */
  key: string;
  /** The capability that declared the job — the first key segment and the script-name segment. */
  capability: string;
  /** The job name — the second key segment. */
  job: string;
  /** The spec as declared. */
  spec: WorkflowSpec;
}

/** The project-wide registry: dispatch key → {@link RegisteredWorkflow}. */
export type WorkflowRegistry = Record<string, RegisteredWorkflow>;
