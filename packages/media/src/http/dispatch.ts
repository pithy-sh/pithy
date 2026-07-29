import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { triggerWorkflow } from "@pithy-sh/core/src/workflow/dispatch";
import { workflowKey } from "@pithy-sh/core/src/workflow/naming";
import type { MediaConfig } from "../config/config";
import { isExtractableDocument } from "../data/enums";
import { MEDIA_CAPABILITY, mediaWorkflowRegistry } from "../workflows/specs";
import type { EnrichmentDispatcher } from "./handlers";

/**
 * A Cloudflare Workflow binding this capability dispatches to. The enrichment Workflows live in the
 * prebuilt media worker (`workflows/worker.ts`); the app worker holds their bindings and starts an
 * instance on finalize.
 */
export interface EnrichmentWorkflowBinding {
  /** Start a Workflow instance for one media record. */
  create(options: { params: { id: string } }): Promise<unknown>;
}

/** The enrichment Workflow bindings, each optional so a project that disables a feature omits it. */
export interface EnrichmentBindings {
  /** Image → alt text / caption. */
  MEDIA_IMAGE_TO_TEXT?: EnrichmentWorkflowBinding;
  /** Audio → transcription. */
  MEDIA_AUDIO_TRANSCRIBE?: EnrichmentWorkflowBinding;
  /** Video → transcription (Stream readiness + HLS batching). */
  MEDIA_VIDEO_TRANSCRIBE?: EnrichmentWorkflowBinding;
  /** Document → extracted text. */
  MEDIA_DOC_EXTRACT?: EnrichmentWorkflowBinding;
}

/**
 * Which job enriches which media type. The binding is no longer named here — the spec map owns it, so
 * this table only has to answer "what runs for a video?".
 */
const JOB_FOR_TYPE = {
  image: "image-to-text",
  audio: "audio-transcribe",
  video: "video-transcribe",
  document: "doc-extract",
} as const;

/**
 * Build the enrichment dispatcher: on finalize it starts the configured Workflow for the record's type,
 * and only when the feature is enabled. Each AI feature is independently opt-in and a true no-op (no
 * dispatch, no cost) when disabled.
 *
 * Dispatch itself goes through core's {@link triggerWorkflow} rather than reaching for `env.X?.create()`.
 * That buys two things the hand-rolled version could not: the `{ id }` payload is validated against the
 * job's own schema before the binding is touched, and an **absent** binding — an unprovisioned project —
 * is logged rather than silently skipped. Enrichment quietly doing nothing, with no error and no log, was
 * the harder failure to diagnose by far.
 */
export function makeEnrichmentDispatcher(
  env: EnrichmentBindings,
  config: MediaConfig,
  log: Logger = noopLogger,
): EnrichmentDispatcher {
  // The bindings are declared as named optional fields for the reader's sake; dispatch reads them by
  // the spec's binding name, which is what a Worker env is.
  const bindings = env as unknown as Record<string, unknown>;

  return async (record) => {
    if (!enabledFor(record.type, record.filename, config)) return;
    const key = workflowKey(MEDIA_CAPABILITY, JOB_FOR_TYPE[record.type]);
    await triggerWorkflow(bindings, mediaWorkflowRegistry, key, { id: String(record.id) }, log);
  };
}

/** Whether the record's enrichment feature is on — and, for a document, whether the file is extractable. */
function enabledFor(type: keyof typeof JOB_FOR_TYPE, filename: string, config: MediaConfig): boolean {
  switch (type) {
    case "image":
      return config.images.imageToText;
    case "audio":
      return config.audio.transcribe;
    case "video":
      return config.video.transcribe;
    case "document":
      // Only pdf/doc/docx are extractable — never enqueue a Workflow for an unsupported extension.
      return config.documents.extractText && isExtractableDocument(filename);
  }
}
