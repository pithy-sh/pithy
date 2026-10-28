// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { pithyCommandOf } from "@pithy-sh/core/src/cli/command";
import { chunkByBoundParameters } from "@pithy-sh/core/src/data/boundParameters";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import type { VectorIndexConfig } from "@pithy-sh/vector/src/config/config";
import type { VectorAi } from "@pithy-sh/vector/src/embed/embed";
import type { VectorStore } from "@pithy-sh/vector/src/index/index";
import { SUPPORT_SEARCH_TABLE, SUPPORT_THREADS_TABLE, type SupportDatabase } from "../data/tables";
import { semanticHits } from "../semantic/query";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from "./paging";
import { type KeywordBackend, keywordHits, type MessageHit } from "./search";
import { applyThreadFilters, type ListedThread, listedThreadOf, type ThreadFilters, viewerThreads } from "./threads";

/**
 * Hybrid search — keyword and semantic, run together and ranked as one.
 *
 * The two fail in opposite directions. Keyword finds the exact string and misses the paraphrase; semantic
 * finds the paraphrase and misses the identifier, because it cannot retrieve an order number it has never
 * seen. A support inbox needs both.
 *
 * **Search is not listing.** A query goes in, ranked threads come out, up to a limit, and there is no cursor:
 * a ranked list has a top, not pages.
 *
 * ## How a result is ranked
 *
 * 1. Each backend returns **messages**, best first — FTS5 by `bm25`, the `LIKE` scan by recency, Vectorize by
 *    similarity.
 * 2. Each list rolls up to **threads**: a thread takes the rank of its best message, and appears once.
 * 3. Hybrid fuses the two thread lists by **reciprocal rank fusion** over rank position — `1 / (60 + rank)`,
 *    summed. No weights to tune, and a thread both backends found rises above one only one found. The raw
 *    scores are never normalized into one number: each result carries its message's `bm25` and similarity as
 *    they were, absent where that backend did not run or did not match.
 * 4. A tie goes to the keyword hit, the better keyword rank first, and then to `lastMessageAt`, newest first.
 *    Semantic search cannot retrieve an identifier, so for a query like `ORD-40912` the exact match is keyword's
 *    rank 1 while semantic's rank 1 is some other thread: equal fused scores, and the exact match wins.
 *
 * **Filters apply after retrieval, in D1**, never as Vectorize metadata, which would go stale the moment a
 * thread is archived, reassigned or reclassified. A narrow filter can therefore return fewer than the limit,
 * and the result's count says how many it did.
 *
 * **Degrade, never fail.** A backend that is on and cannot answer — FTS5 configured and its table not
 * provisioned, the semantic index or its binding absent, a model that does not answer — is skipped and named,
 * and the rest of the search still runs.
 */

/** The search modes a caller may ask for. */
export type SearchMode = "keyword" | "semantic" | "hybrid";

/** A backend that can answer part of a search. */
export type SearchBackend = KeywordBackend | "semantic";

/** Why a backend that is on did not answer. */
export type SkipReason = "unprovisioned" | "failed";

/** The reciprocal-rank-fusion constant — the standard 60, which damps the head without flattening it. */
export const RRF_K = 60;

/** How many messages each backend retrieves before the roll-up. Vectorize's payload-free ceiling. */
export const SEARCH_HITS = 100;

/** One thread a backend ranked, with the message that ranked it. */
export interface RankedThread {
  /** The thread. */
  threadId: string;
  /** Its best-matching message. */
  messageId: string;
  /** Its rank in this backend's list, 1 first. */
  rank: number;
}

/**
 * Roll a backend's message hits up to threads: a thread takes the rank of its best message, and appears once.
 * The input is best first, so the first message seen for a thread is its best.
 */
export function rollUp(hits: readonly MessageHit[]): RankedThread[] {
  const seen = new Set<string>();
  const ranked: RankedThread[] = [];
  for (const hit of hits) {
    if (seen.has(hit.threadId)) continue;
    seen.add(hit.threadId);
    ranked.push({ threadId: hit.threadId, messageId: hit.messageId, rank: ranked.length + 1 });
  }
  return ranked;
}

/** One thread after fusion: its fused score and the message the result names. */
export interface FusedThread {
  /** The thread. */
  threadId: string;
  /** The message the result names — the one from the backend that ranked this thread higher. */
  messageId: string;
  /** The reciprocal-rank-fusion score. Internal: it orders results and is never reported. */
  fused: number;
}

/**
 * Fuse ranked thread lists by reciprocal rank fusion. A thread found by several lists sums its terms.
 *
 * The message a result names comes from the list that ranked the thread highest, the first list winning a
 * tie — the keyword list is passed first, so an exact match names the message that holds it.
 */
export function fuse(lists: readonly (readonly RankedThread[])[]): FusedThread[] {
  const fused = new Map<string, FusedThread & { best: number }>();
  for (const list of lists) {
    for (const entry of list) {
      const term = 1 / (RRF_K + entry.rank);
      const known = fused.get(entry.threadId);
      if (!known) {
        fused.set(entry.threadId, {
          threadId: entry.threadId,
          messageId: entry.messageId,
          fused: term,
          best: entry.rank,
        });
        continue;
      }
      known.fused += term;
      if (entry.rank < known.best) {
        known.best = entry.rank;
        known.messageId = entry.messageId;
      }
    }
  }
  return [...fused.values()].map(({ threadId, messageId, fused: score }) => ({ threadId, messageId, fused: score }));
}

/** What a search asks. */
export interface SearchThreadsQuery extends ThreadFilters {
  /** The words. */
  q: string;
  /** Which backends to run. Absent runs every backend that is on. */
  mode?: SearchMode;
  /** How many threads to return. Defaults to {@link DEFAULT_SEARCH_LIMIT}, capped at {@link MAX_SEARCH_LIMIT}. */
  limit?: number;
}

/** What a search needs. The semantic seams are absent exactly when that backend cannot run here. */
export interface SearchDeps {
  /** The support tables. */
  db: SupportDatabase;
  /** Whether `search.fts` is on. */
  fts: boolean;
  /** The message index, when `search.semantic` is on. */
  index?: VectorIndexConfig;
  /** The Workers AI binding, when bound. */
  ai?: VectorAi;
  /** The message index's Vectorize binding, when bound. */
  store?: VectorStore;
  /** The calling viewer — whose read and snooze state each result carries. */
  viewer: string;
  /** Where a skipped backend is reported to the operator. */
  log?: Logger;
}

/** One search result: a thread, and the message that matched best with its raw scores. */
export interface SearchResult {
  /** The thread, as this viewer sees it. */
  thread: ListedThread;
  /** The best-matching message. */
  messageId: string;
  /** That message's FTS5 `bm25`, raw — lower is better. Absent when FTS5 did not run or did not match it. */
  bm25?: number;
  /** That message's similarity to the query, raw. Absent when semantic search did not run or did not match it. */
  similarity?: number;
}

/** What a search did, and what it found. */
export interface SearchOutcome {
  /** The mode that ran — the one asked for, or `hybrid` when none was. */
  mode: SearchMode;
  /** The backends that answered. */
  ran: SearchBackend[];
  /** The backends that were on and could not answer, and why. */
  skipped: { backend: SearchBackend; reason: SkipReason }[];
  /** The threads, best first. */
  results: SearchResult[];
}

/** Whether an error is SQLite saying the full-text index does not exist. */
function isMissingSearchTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("no such table") && message.includes(SUPPORT_SEARCH_TABLE);
}

/** A refusal for a mode this configuration cannot run. */
function semanticOff(mode: SearchMode): ValidationError {
  return new ValidationError({
    message: `Search mode \`${mode}\` needs semantic search, and \`search.semantic\` is off.`,
    action: `Turn on \`search.semantic\` in support()'s config and run \`${pithyCommandOf("support provision", {}, { runtime: true })}\`, or search with \`mode=keyword\`.`,
    detail: `mode ${mode} requested with search.semantic off`,
  });
}

/** Run a search. */
export async function searchThreads(deps: SearchDeps, query: SearchThreadsQuery): Promise<SearchOutcome> {
  const semanticOn = deps.index !== undefined;
  if ((query.mode === "semantic" || query.mode === "hybrid") && !semanticOn) throw semanticOff(query.mode);
  const mode: SearchMode = query.mode ?? "hybrid";
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);

  const ran: SearchBackend[] = [];
  const skipped: SearchOutcome["skipped"] = [];
  const lists: RankedThread[][] = [];
  const keywordRank = new Map<string, number>();
  const bm25 = new Map<string, number>();
  const similarity = new Map<string, number>();

  if (mode !== "semantic") {
    let backend: KeywordBackend = deps.fts ? "fts" : "like";
    let hits: MessageHit[];
    try {
      hits = await keywordHits(deps.db, query.q, { backend, limit: SEARCH_HITS });
    } catch (error) {
      // **The index being configured on is not the same as the index existing.** A project that turned
      // `search.fts` on and has not re-provisioned gets the `LIKE` scan — slower, and still an answer —
      // and the result says FTS5 was skipped. Narrow on purpose: a genuine query bug still surfaces.
      if (backend !== "fts" || !isMissingSearchTable(error)) throw error;
      deps.log?.warn("support FTS index is configured but absent — searching with a LIKE scan", {
        action: `Run \`${pithyCommandOf("support provision", {}, { runtime: true })}\` to create and backfill it, or set \`search.fts: false\`.`,
      });
      skipped.push({ backend: "fts", reason: "unprovisioned" });
      backend = "like";
      hits = await keywordHits(deps.db, query.q, { backend, limit: SEARCH_HITS });
    }
    ran.push(backend);
    if (backend === "fts") for (const hit of hits) if (hit.score !== undefined) bm25.set(hit.messageId, hit.score);
    const keywordList = rollUp(hits);
    for (const entry of keywordList) keywordRank.set(entry.threadId, entry.rank);
    lists.push(keywordList);
  }

  if (mode !== "keyword" && deps.index) {
    if (!deps.ai || !deps.store) {
      // The index has not been provisioned for this Worker yet: its binding, or the model's, is absent.
      deps.log?.warn("support semantic search is on but its index is not bound — skipping it", {
        action: `Run \`${pithyCommandOf("support provision", {}, { runtime: true })}\` to create the index and bind it.`,
      });
      skipped.push({ backend: "semantic", reason: "unprovisioned" });
    } else {
      try {
        const hits = await semanticHits({ db: deps.db, ai: deps.ai, store: deps.store, index: deps.index }, query.q);
        for (const hit of hits) if (hit.score !== undefined) similarity.set(hit.messageId, hit.score);
        lists.push(rollUp(hits));
        ran.push("semantic");
      } catch (error) {
        deps.log?.warn("support semantic search could not answer — skipping it", {
          detail: error instanceof Error ? error.message : String(error),
        });
        skipped.push({ backend: "semantic", reason: "failed" });
      }
    }
  }

  const fused = fuse(lists);
  const threads = await hydrate(
    deps.db,
    deps.viewer,
    fused.map((entry) => entry.threadId),
    query,
  );
  const results = fused
    .flatMap((entry) => {
      const thread = threads.get(entry.threadId);
      return thread ? [{ entry, thread }] : [];
    })
    .sort(
      (a, b) =>
        b.entry.fused - a.entry.fused ||
        (keywordRank.get(a.entry.threadId) ?? Number.POSITIVE_INFINITY) -
          (keywordRank.get(b.entry.threadId) ?? Number.POSITIVE_INFINITY) ||
        b.thread.lastMessageAt.getTime() - a.thread.lastMessageAt.getTime() ||
        (a.thread.id < b.thread.id ? 1 : a.thread.id > b.thread.id ? -1 : 0),
    )
    .slice(0, limit)
    .map(({ entry, thread }): SearchResult => {
      const keyword = bm25.get(entry.messageId);
      const near = similarity.get(entry.messageId);
      return {
        thread,
        messageId: entry.messageId,
        ...(keyword !== undefined ? { bm25: keyword } : {}),
        ...(near !== undefined ? { similarity: near } : {}),
      };
    });

  return { mode, ran, skipped, results };
}

/** The filter values bind before the id list; this is the most a filtered read can bind besides it. */
const HYDRATE_FIXED_PARAMETERS = 12;

/** Read the candidate threads that pass the caller's filters, as this viewer sees them. */
async function hydrate(
  db: SupportDatabase,
  viewer: string,
  threadIds: readonly string[],
  filters: ThreadFilters,
): Promise<Map<string, ListedThread>> {
  const threads = new Map<string, ListedThread>();
  if (threadIds.length === 0) return threads;
  for (const group of chunkByBoundParameters(threadIds, HYDRATE_FIXED_PARAMETERS)) {
    const rows = await applyThreadFilters(viewerThreads(db, viewer), filters)
      .where(`${SUPPORT_THREADS_TABLE}.id`, "in", group)
      .execute();
    for (const row of rows) {
      const thread = listedThreadOf(row);
      threads.set(thread.id, thread);
    }
  }
  return threads;
}
