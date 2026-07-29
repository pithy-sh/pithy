import { workflowKey } from "@pithy-sh/core/src/workflow/naming";
import type { WorkflowRegistry, WorkflowSpecMap } from "@pithy-sh/core/src/workflow/spec";
import { z } from "zod";

/**
 * The one durable job vector owns, declared once.
 *
 * Re-embedding a corpus is the job that has to be a Workflow. Ten million vectors is an ordinary size for a
 * Vectorize index, and re-embedding them is hours of Workers AI calls: a request would time out, a queue
 * consumer would lose its place, and a script on someone's laptop would die with the lid. A Workflow's steps
 * are journalled, so an interrupted run resumes at the page it reached rather than starting over — and
 * starting over is not merely slow, it is what makes people not re-embed at all.
 *
 * The spec is `optional: true`: the binding exists only once `pithy vector provision` has deployed the
 * reprocess worker, and a project that has not provisioned must still boot and serve every search route.
 */

/** The capability name — the first segment of the dispatch key and of every deployed workflow name. */
export const VECTOR_CAPABILITY = "vector";

/** The parameters a reprocess run takes: which index, how much of it, and how it is scoped. */
export const VectorReprocessParams = z
  .object({
    index: z.string().min(1).describe("The index to re-embed, as named in pithy.config.ts. One run covers one index."),
    all: z
      .boolean()
      .optional()
      .describe(
        "Re-embed every document, not just the drifted ones. The default pass selects only rows whose model differs from the configured one — including rows that were never embedded at all.",
      ),
    filter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Narrow the run to documents whose metadata matches this filter. Evaluated against the corpus rows, so it uses the same operators a query filter does.",
      ),
    pageSize: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Documents per Workflow step. Defaults to the Vectorize upsert ceiling of 1,000, which is also the largest batch one step can write.",
      ),
  })
  .describe("The instance parameters of a reprocess run — which index to re-embed, and how much of it.");
export type VectorReprocessParams = z.infer<typeof VectorReprocessParams>;

/** Vector's durable jobs, keyed by job name. The key is the second segment of the `vector/<job>` dispatch key. */
export const vectorWorkflows = {
  reprocess: {
    binding: "VECTOR_REPROCESS",
    className: "VectorReprocessWorkflow",
    params: VectorReprocessParams,
    optional: true,
  },
} as const satisfies WorkflowSpecMap;

/**
 * Vector's jobs as a dispatch registry, keyed `vector/<job>`. Built from the same map and core's
 * {@link workflowKey}, so the dispatch key, the deployed name, and the binding cannot drift apart.
 */
export const vectorWorkflowRegistry: WorkflowRegistry = Object.fromEntries(
  Object.entries(vectorWorkflows).map(([job, spec]) => {
    const key = workflowKey(VECTOR_CAPABILITY, job);
    return [key, { key, capability: VECTOR_CAPABILITY, job, spec }];
  }),
);
