// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowRetryPolicy } from "@pithy-sh/core/src/workflow/faults";

/**
 * **What an enrichment retries, and what it refuses to.**
 *
 * Enrichment is the one shape in this kit where terminal is *expensive*. The four Workflows are started
 * once, on finalize, and nothing starts them again: a fault the step calls terminal is an asset that
 * silently keeps no alt text and no transcription, and nobody finds out because a missing caption looks
 * exactly like a caption nobody wanted. So the retryable list here is longer than most, and every entry
 * on it is a service this capability does not control (pithy-sh/pithy#348).
 *
 * ## Retryable, and why
 *
 * - **`core/upstream_failed`** — Workers AI rejected the call. Raised at the one seam in `ai/enrich.ts`
 *   that wraps the binding, and *only* there: a model that answered in a shape the schema refuses is
 *   `media/enrichment_failed` and stays terminal. The split is by code rather than by phrasing because
 *   the step can only act on a code. A model that was overloaded for ten seconds answers on the second
 *   attempt.
 * - **`cloudflare/request_failed`** — the Stream REST API, unreachable or answering 5xx. Video
 *   transcription asks Stream for an HLS playback URL before it fetches a single byte, and
 *   `cloudflareRequest` folds every transport failure into this one code.
 * - **`media/enrichment_failed`** — **the deliberate exception, and the reason it earns its place is
 *   `fetchVideoAudio`.** A video whose Stream asset has not finished encoding has no HLS playback URL
 *   yet, and that is what the enrichment raises: not a refusal, a *not yet*. It is the single most
 *   likely failure of a video Workflow started the moment an upload finalizes, and it resolves on its
 *   own within a minute. The cost of admitting it is that the code's other producers — an R2 object that
 *   is genuinely missing, a manifest with no audio rendition — buy five cheap attempts before failing.
 *   That is a worse diagnosis and a bounded one; a transcription permanently lost to an encode still in
 *   progress is neither.
 * - **A transient D1 fault** — the media table, when records live in D1. Classified in core by
 *   `withD1Retry`, never restated here.
 *
 * ## Terminal, and why
 *
 * - **`media/not_found`** — the record is gone. A Workflow instance outliving its row is ordinary, and
 *   the row does not come back over a backoff.
 * - **`media/unsupported`** — a type or backend enrichment cannot read. A fact about the asset.
 * - **`media/storage_failed`** — a mint, a delete, or a presign the storage plane refused. None of them
 *   run inside an enrichment step; one reaching here is a bug, and a bug should surface.
 * - **`cloudflare/invalid_response`, `cloudflare/not_configured`** — a Stream response that did not
 *   match its schema, or a manager with no account id. A shape and a config; neither changes.
 * - **`validation/invalid_input`** — a config or a payload the schema refuses.
 */
export const mediaWorkflowRetry: WorkflowRetryPolicy = {
  capability: "media",
  retryable: {
    "core/upstream_failed":
      "Workers AI rejected the call rather than answering it; an overloaded model answers next time.",
    "cloudflare/request_failed": "The Stream API could not be reached; the same read is idempotent and may reach it.",
    "media/enrichment_failed":
      "A video's Stream asset may still be encoding, so it has no HLS audio yet — a not-yet rather than a refusal.",
  },
};
