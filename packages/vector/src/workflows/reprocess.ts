// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { VectorIndexConfig } from "../config/config";
import type { VectorDocument } from "../data/document";
import type { DocumentStore } from "../data/documents";
import { embedBatched, type VectorAi } from "../embed/embed";
import { type CompiledFilter, matchesCompiledFilter } from "../index/filter";
import { upsertVectors, type VectorStore, type VectorUpsert } from "../index/index";
import { MAX_UPSERT_BATCH } from "../index/limits";

/**
 * Re-embed a corpus, one durable page at a time.
 *
 * The orchestration is pure: the Workflow step runner, the document store, the index, and the AI binding all
 * arrive as parameters, so the whole of it — including resuming mid-run — is tested with fakes and no
 * network. `workflows/worker.ts` is the thin `WorkflowEntrypoint` that supplies the real ones.
 *
 * **Pagination is keyset, not offset, and that is the correctness argument for the whole file.** The default
 * pass selects rows whose `model` differs from the configured one and then *sets* that model on the rows it
 * writes — so the result set shrinks underneath the scan. With `LIMIT/OFFSET` that is the classic skip bug:
 * page two starts at row 1,000 of a set that just lost its first 1,000 members, and half the corpus is never
 * re-embedded, silently. Reading `id > cursor` in id order cannot skip and cannot repeat, whatever the
 * predicate does to the rows behind the cursor.
 *
 * **Each page is one `step.do`.** Workflow steps are journalled, so an instance that dies at page 4,000
 * resumes at page 4,000 with the same cursor rather than re-embedding four million documents. The step names
 * are derived from a page counter, so a replay asks for the same steps in the same order — which is what
 * makes the journal usable at all.
 *
 * A row written during the run whose id sorts *behind* the cursor is not picked up. That is the honest cost
 * of keyset order, and it is not a problem in practice: a document written after the model changed is
 * embedded with the new model by the write path anyway.
 */

/** The Workflow step runner, structurally. Injectable, so a test can journal and replay it. */
export interface ReprocessStep {
  /** Run a named step, or return its journalled result if this instance already completed it. */
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** What a reprocess run needs. Every one is a seam. */
export interface ReprocessDeps {
  /** The document corpus — the source of the text and the destination of the new model stamp. */
  documents: DocumentStore;
  /** The Vectorize index the re-embedded vectors are written to. */
  store: VectorStore;
  /** The Workers AI binding. */
  ai: VectorAi;
  /** The index's resolved config — the model to embed with and the shape to prove. */
  index: VectorIndexConfig;
  /** The index's config name, which scopes the corpus rows. */
  indexName: string;
  /** Clock, injected so the stamped `updatedAt` is assertable. */
  now(): Date;
}

/** How much of the corpus a run covers. */
export interface ReprocessOptions {
  /** Re-embed every document, not only the ones whose model drifted. */
  all?: boolean;
  /** Narrow the run to documents whose metadata matches. Compile it before passing it in. */
  filter?: CompiledFilter;
  /** Documents per step. Defaults to — and is capped at — the Vectorize upsert ceiling. */
  pageSize?: number;
}

/** What one page did. Returned through the step, so a replay restores it exactly. */
interface PageResult {
  /** The id to read after on the next page, or null when the corpus is exhausted. */
  cursor: string | null;
  /** Rows read. */
  scanned: number;
  /** Rows re-embedded and written. */
  reembedded: number;
  /** Rows that matched but hold no content, so there is nothing to embed. */
  skipped: number;
  /** Whether this was the last page. */
  done: boolean;
}

/** The tally a run reports. */
export interface ReprocessReport {
  /** The index that was reprocessed. */
  indexName: string;
  /** How many pages the run took — one Workflow step each. */
  pages: number;
  /** Rows read. */
  scanned: number;
  /** Rows re-embedded and written back. */
  reembedded: number;
  /** Rows selected but skipped because the corpus holds no text for them. */
  skipped: number;
}

/** Re-embed one page's documents and write them back. The body of a step. */
async function reembedPage(deps: ReprocessDeps, documents: readonly VectorDocument[]): Promise<number> {
  const embeddable = documents.filter((document) => document.content !== null);
  if (embeddable.length === 0) return 0;

  const vectors = await embedBatched(
    deps.ai,
    deps.index,
    embeddable.map((document) => document.content as string),
  );

  const upserts: VectorUpsert[] = embeddable.map((document, position) => ({
    id: document.id,
    values: vectors[position] as number[],
    metadata: document.metadata,
    ...(document.namespace ? { namespace: document.namespace } : {}),
  }));

  await upsertVectors(deps.store, deps.index, upserts);
  // Stamped only after the write is accepted, so a step that dies mid-page leaves the rows selectable by the
  // next run rather than marked done.
  await deps.documents.markEmbedded(
    deps.indexName,
    embeddable.map((document) => document.id),
    deps.index.model,
    deps.now(),
  );
  return embeddable.length;
}

/**
 * Re-embed an index's documents. Resumable by construction: every page is a journalled step keyed by its
 * page number, and the cursor that drives the next page comes out of the previous step's result.
 */
export async function reprocessIndex(
  deps: ReprocessDeps,
  step: ReprocessStep,
  options: ReprocessOptions = {},
): Promise<ReprocessReport> {
  const limit = Math.min(options.pageSize ?? MAX_UPSERT_BATCH, MAX_UPSERT_BATCH);
  const report: ReprocessReport = { indexName: deps.indexName, pages: 0, scanned: 0, reembedded: 0, skipped: 0 };

  let cursor: string | null = null;
  let page = 0;

  for (;;) {
    page += 1;
    const after = cursor;
    // Zero-padded so the step names sort the way the pages ran — the journal is read by humans too.
    const result: PageResult = await step.do(`page-${String(page).padStart(6, "0")}`, async () => {
      const rows = await deps.documents.page({
        indexName: deps.indexName,
        after,
        limit,
        ...(options.all ? {} : { staleModel: deps.index.model }),
      });
      if (rows.length === 0) return { cursor: after, scanned: 0, reembedded: 0, skipped: 0, done: true };

      const last = rows[rows.length - 1] as VectorDocument;
      const selected = options.filter
        ? rows.filter((row) => matchesCompiledFilter(row.metadata, options.filter as CompiledFilter))
        : rows;
      const reembedded = await reembedPage(deps, selected);

      return {
        cursor: last.id,
        scanned: rows.length,
        reembedded,
        skipped: selected.length - reembedded,
        // A short page means the corpus is exhausted. A full page might still be the last one; the next
        // step reads zero rows and ends the run, which costs one cheap query and no special case.
        done: rows.length < limit,
      };
    });

    report.pages = page;
    report.scanned += result.scanned;
    report.reembedded += result.reembedded;
    report.skipped += result.skipped;
    cursor = result.cursor;
    if (result.done) break;
  }

  return report;
}
