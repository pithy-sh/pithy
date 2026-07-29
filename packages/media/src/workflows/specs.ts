import { workflowKey } from "@pithy-sh/core/src/workflow/naming";
import type { WorkflowRegistry, WorkflowSpecMap } from "@pithy-sh/core/src/workflow/spec";
import { z } from "zod";

/**
 * The four enrichment jobs media owns, declared once.
 *
 * This map is the single description of media's durable work. `capability.ts` derives the four
 * `workflow` bindings from it, `http/dispatch.ts` dispatches through it, and `pithy media provision`
 * resolves the host worker's `workflows` array and per-environment names from it. Previously the same
 * facts were written three times — in the capability's bindings, in the hand-rolled dispatcher, and in
 * the committed `wrangler.jsonc` — and nothing kept them in agreement.
 *
 * Every job is `optional: true`. The Workflows live in the prebuilt media worker, deployed only by
 * `pithy media provision`, so a project that has not provisioned must still boot and serve every
 * non-enrichment route. An absent binding degrades to a logged skip, never a startup failure.
 */

/** The capability name — the first segment of every media dispatch key and deployed workflow name. */
export const MEDIA_CAPABILITY = "media";

/** The parameters every enrichment job takes: which media record to enrich. */
export const MediaEnrichmentParams = z
  .object({
    id: z
      .string()
      .min(1)
      .describe("The media record's id. The Workflow reads that record, enriches it, and writes the result back."),
  })
  .describe("The instance parameters of an enrichment Workflow — the one record it runs against.");
export type MediaEnrichmentParams = z.infer<typeof MediaEnrichmentParams>;

/** Media's durable jobs, keyed by job name. The key is the second segment of the `media/<job>` dispatch key. */
export const mediaWorkflows = {
  "image-to-text": {
    binding: "MEDIA_IMAGE_TO_TEXT",
    className: "MediaImageToTextWorkflow",
    params: MediaEnrichmentParams,
    optional: true,
  },
  "audio-transcribe": {
    binding: "MEDIA_AUDIO_TRANSCRIBE",
    className: "MediaAudioTranscribeWorkflow",
    params: MediaEnrichmentParams,
    optional: true,
  },
  "video-transcribe": {
    binding: "MEDIA_VIDEO_TRANSCRIBE",
    className: "MediaVideoTranscribeWorkflow",
    params: MediaEnrichmentParams,
    optional: true,
  },
  "doc-extract": {
    binding: "MEDIA_DOC_EXTRACT",
    className: "MediaDocExtractWorkflow",
    params: MediaEnrichmentParams,
    optional: true,
  },
} as const satisfies WorkflowSpecMap;

/**
 * Media's jobs as a dispatch registry, keyed `media/<job>`. Built here rather than through
 * `composeWorkflows` because the routes dispatch from inside the media capability, before any
 * project-wide registry exists — and the key format comes from core's {@link workflowKey} either way,
 * so the two cannot drift.
 */
export const mediaWorkflowRegistry: WorkflowRegistry = Object.fromEntries(
  Object.entries(mediaWorkflows).map(([job, spec]) => {
    const key = workflowKey(MEDIA_CAPABILITY, job);
    return [key, { key, capability: MEDIA_CAPABILITY, job, spec }];
  }),
);
