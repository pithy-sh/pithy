import { fromZodError, NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import type { VectorIndexConfig } from "../config/config";
import type { VectorDocument } from "../data/document";
import type { DocumentStore } from "../data/documents";
import type { VectorAi } from "../embed/embed";
import { embedBatched } from "../embed/embed";
import { compileFilter } from "../index/filter";
import { deleteVectors, queryVectors, upsertVectors, type VectorStore, type VectorUpsert } from "../index/index";
import type { MetadataIndexDescriptor } from "../index/metadata";
import { QueryInput, UpsertDocumentsInput, type VectorDocumentInput } from "./schemas";

/**
 * The vector route handlers, over an injected {@link HandlerDeps} rather than a request context — so every
 * one of them is unit-tested against fakes with no Worker, no Vectorize, and no network. Vectorize has no
 * local emulation, so this is the only way any of this gets a test at all.
 *
 * Two orderings here are load-bearing and are the reason these are handlers rather than three lines each.
 *
 * **A write lands in D1 first, and the row's `model` is set only after Vectorize accepts the vector.** The
 * corpus is the durable thing: Vectorize hands back ids and scores, never content, so a document that
 * reached the index but not the table can never be re-embedded. Writing D1 first makes a half-failed write
 * recoverable, and leaving `model` null until the vector is accepted makes it recoverable *by the default
 * `pithy vector reprocess` pass*, which selects exactly the rows whose model is not the configured one.
 *
 * **A delete leaves the index first.** The reverse order — D1 then Vectorize — turns a failure into a vector
 * that still matches queries but can never be hydrated, which surfaces as a result set that quietly shrinks.
 *
 * Vectorize applies writes asynchronously: `mutationId` is an acknowledgement, not a completed write.
 * Nothing here reads back what it just wrote.
 */

/** Everything a handler needs, resolved per request by the route layer. */
export interface HandlerDeps {
  /** The document corpus in D1 — what results hydrate from and re-embeds read out of. */
  documents: DocumentStore;
  /** The Vectorize index this request addresses, resolved from the index's declared binding. */
  store: VectorStore;
  /** The Workers AI binding, for embedding text. */
  ai: VectorAi;
  /** The resolved config of the index named in the path. */
  index: VectorIndexConfig;
  /** The index's name as `pithy.config.ts` declares it — the D1 scope key and the path segment. */
  indexName: string;
  /** The metadata indexes this index declares, introspected once at route registration. */
  filterable: readonly MetadataIndexDescriptor[];
  /** Matches to return when a query names no `topK` — the capability's configured `defaultTopK`. */
  defaultTopK: number;
  /** Id source for a document that supplies none. */
  newId(): string;
  /** Clock, injected so timestamps are assertable. */
  now(): Date;
}

/** What a write returns: the ids written and Vectorize's acknowledgement of the enqueued mutation. */
export interface UpsertResult {
  /** The document ids written, in request order. */
  ids: string[];
  /** Vectorize's mutation id. The write is enqueued, not yet visible to a query. */
  mutationId: string;
}

/** One match, hydrated. `document` is null when the index holds a vector the corpus no longer has. */
export interface QueryMatchResult {
  /** The matched vector's id. */
  id: string;
  /** The similarity score, as scored by the index's metric. */
  score: number;
  /** The document behind the match, or null when D1 has no row for it. */
  document: VectorDocument | null;
}

/** What a search returns. */
export interface QueryResult {
  /** How many matches came back. */
  count: number;
  /** The matches, nearest first, each hydrated from the document corpus. */
  matches: QueryMatchResult[];
}

/** Normalize the two accepted write shapes — a batch, or a bare document — into one list. */
function documentsOf(body: unknown): VectorDocumentInput[] {
  const parsed = UpsertDocumentsInput.safeParse(body);
  if (!parsed.success) throw fromZodError(parsed.error);
  return "documents" in parsed.data ? [...parsed.data.documents] : [parsed.data];
}

/**
 * Write one or many documents into an index. Text is embedded with the index's pinned model; a supplied
 * `values` array is inserted as-is. Ids may be supplied to make the write idempotent.
 */
export async function upsertDocuments(deps: HandlerDeps, body: unknown): Promise<UpsertResult> {
  const inputs = documentsOf(body);
  const at = deps.now();

  // Embed every text in one call: Workers AI charges per request, and a batch keeps the vectors of one
  // write in the same model invocation.
  const toEmbed = inputs.filter((input) => input.text !== undefined);
  const embedded =
    toEmbed.length > 0
      ? await embedBatched(
          deps.ai,
          deps.index,
          toEmbed.map((input) => input.text as string),
        )
      : [];

  const ids: string[] = [];
  const documents: VectorDocument[] = [];
  const vectors: VectorUpsert[] = [];
  let embeddedAt = 0;

  for (const input of inputs) {
    const id = input.id ?? deps.newId();
    const values = input.values ?? (embedded[embeddedAt++] as number[]);
    const namespace = input.namespace ?? deps.index.namespace;
    ids.push(id);
    documents.push({
      id,
      indexName: deps.indexName,
      namespace: namespace ?? null,
      content: input.content ?? input.text ?? null,
      metadata: input.metadata ?? {},
      // Null until Vectorize accepts the vector — see the ordering note at the top of this file.
      model: null,
      createdAt: at,
      updatedAt: at,
    });
    vectors.push({
      id,
      values,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(namespace ? { namespace } : {}),
    });
  }

  await deps.documents.put(documents);
  const mutationId = await upsertVectors(deps.store, deps.index, vectors);
  await deps.documents.markEmbedded(deps.indexName, ids, deps.index.model, at);

  return { ids, mutationId };
}

/**
 * Search an index and hydrate the matches from the document corpus. Vectorize returns ids and scores;
 * neither values nor metadata is requested, which both keeps the response small and raises the topK ceiling
 * from 50 to 100 — the content comes from D1, where it is authoritative anyway.
 */
export async function queryDocuments(deps: HandlerDeps, body: unknown): Promise<QueryResult> {
  const parsed = QueryInput.safeParse(body);
  if (!parsed.success) throw fromZodError(parsed.error);
  const input = parsed.data;

  const vector = input.values ?? ((await embedBatched(deps.ai, deps.index, [input.text as string]))[0] as number[]);
  const filter = input.filter ? compileFilter(deps.filterable, input.filter) : undefined;

  const result = await queryVectors(deps.store, deps.index, vector, {
    topK: input.topK ?? deps.defaultTopK,
    ...(input.namespace ? { namespace: input.namespace } : {}),
    ...(filter ? { filter } : {}),
  });

  const hydrated = await deps.documents.byIds(
    deps.indexName,
    result.matches.map((match) => match.id),
  );
  const byId = new Map(hydrated.map((document) => [document.id, document]));

  return {
    count: result.count,
    // Order comes from Vectorize, not from D1: the score ranking is the answer, and a match the corpus has
    // lost is reported as a null document rather than dropped, because a silently shorter result set is the
    // failure mode this package exists to make visible.
    matches: result.matches.map((match) => ({
      id: match.id,
      score: match.score,
      document: byId.get(match.id) ?? null,
    })),
  };
}

/** Fetch one hydrated document. */
export async function getDocument(deps: HandlerDeps, id: string): Promise<VectorDocument> {
  const document = await deps.documents.get(deps.indexName, id);
  if (!document) {
    throw new NotFoundError({
      message: "No such document.",
      action: "Check the id, or write the document first.",
      detail: `no document '${id}' in index '${deps.indexName}'`,
    });
  }
  return document;
}

/** What a delete returns. */
export interface DeleteResult {
  /** The id that was removed. */
  id: string;
  /** Vectorize's mutation id for the enqueued delete. */
  mutationId: string;
}

/** Delete a document from the index and from the corpus, in that order. */
export async function deleteDocument(deps: HandlerDeps, id: string): Promise<DeleteResult> {
  // Read first, so an unknown id is a 404 rather than a mutation against nothing.
  await getDocument(deps, id);
  const mutationId = await deleteVectors(deps.store, [id]);
  await deps.documents.remove(deps.indexName, id);
  return { id, mutationId };
}
