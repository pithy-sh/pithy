import type { MediaConfig } from "../config/config";
import { isExtractableDocument } from "../data/enums";
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
 * Build the enrichment dispatcher: on finalize it starts the configured Workflow for the record's type,
 * and only when both the feature is enabled and its binding is present. Each AI feature is independently
 * opt-in and a true no-op (no dispatch, no cost) when disabled.
 */
export function makeEnrichmentDispatcher(env: EnrichmentBindings, config: MediaConfig): EnrichmentDispatcher {
  return async (record) => {
    const id = String(record.id);
    switch (record.type) {
      case "image":
        if (config.images.imageToText) await env.MEDIA_IMAGE_TO_TEXT?.create({ params: { id } });
        return;
      case "audio":
        if (config.audio.transcribe) await env.MEDIA_AUDIO_TRANSCRIBE?.create({ params: { id } });
        return;
      case "video":
        if (config.video.transcribe) await env.MEDIA_VIDEO_TRANSCRIBE?.create({ params: { id } });
        return;
      case "document":
        // Only pdf/doc/docx are extractable — never enqueue a Workflow for an unsupported extension.
        if (config.documents.extractText && isExtractableDocument(record.filename)) {
          await env.MEDIA_DOC_EXTRACT?.create({ params: { id } });
        }
        return;
    }
  };
}
