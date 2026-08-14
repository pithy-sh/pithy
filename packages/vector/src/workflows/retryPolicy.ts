// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { WorkflowRetryPolicy } from "@pithy-sh/core/src/workflow/faults";

/**
 * **What a reprocess retries, and what it refuses to.**
 *
 * A reprocess is a corpus-sized job: one journalled step per keyset page, thousands of them for a
 * corpus worth re-embedding at all. That shape decides the policy in both directions. A page lost to a
 * model blip takes the whole instance's remaining pages with it, so an outage must be retryable; and a
 * refusal that will not change — a model pinned to the wrong dimensions, a filter naming a field the
 * index cannot filter on — must fail on page one rather than on page one after five attempts
 * (pithy-sh/pithy#348).
 *
 * ## Retryable, and why
 *
 * - **`core/upstream_failed`** — Workers AI rejected the embedding call. Raised at the one wrap around
 *   `ai.run` in `embedTexts`, and it means the model did not answer. Re-embedding a page is idempotent —
 *   the rows are stamped with the new model only *after* the upsert is accepted, so a page that died
 *   mid-write is still selectable by the next attempt rather than marked done.
 * - **A transient D1 fault** — the document corpus: the page read and the `markEmbedded` write.
 *   Classified in core by `withD1Retry`, never restated here.
 *
 * ## Terminal, and why
 *
 * - **`vector/dimension_mismatch`** — the configured model produced vectors the index cannot hold. An
 *   index's dimensions are fixed at creation; this is a config error caught on the first page, which is
 *   exactly where you want it, and it wants a new index rather than a backoff.
 * - **`vector/index_not_found`** — no such index in `VECTOR_CONFIG`. Raised before the first step even
 *   runs, and answered by `pithy vector provision`.
 * - **`vector/unfilterable_field`, `vector/filter_too_large`, `vector/topk_exceeded`,
 *   `vector/metadata_too_large`** — limits and shapes. Every one is deterministic in the input, and
 *   three of them are compiled against the provisioned metadata indexes *before* a single document is
 *   re-embedded.
 * - **`vector/metadata_index_drift`** — Vectorize is missing an index the config declares. Provisioning,
 *   not weather.
 * - **`core/internal`** — the model or the store answered in a shape nobody recognises, or the binding
 *   does not expose the method. A shape is not a transient.
 * - **`validation/invalid_input`** — an empty batch, a `topK` below one, a namespace the schema refuses.
 *
 * **What this cannot say.** A Vectorize `upsert` that fails at the binding throws whatever the binding
 * threw — not a `PithyError`, so `unclassified`, so terminal. The step stamps `markEmbedded` only after
 * the upsert is accepted, so the page is re-selected by the next run rather than skipped; the run is
 * lost, the corpus is not. That is a default rather than a decision, and no policy record can turn it
 * into one.
 */
export const vectorWorkflowRetry: WorkflowRetryPolicy = {
  capability: "vector",
  retryable: {
    "core/upstream_failed":
      "The embedding model did not answer; a page is re-selectable until its upsert is accepted, so re-driving it repeats nothing.",
  },
};
