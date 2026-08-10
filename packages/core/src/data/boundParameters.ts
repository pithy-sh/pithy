// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { InternalError } from "../error/pithyError";

/**
 * D1's bound-parameter ceiling, and the chunking every `in (...)` list needs to stay under it.
 *
 * D1 rejects a statement carrying more than 100 bound parameters. The failure mode is the nastiest kind:
 * every small test passes, and the query only breaks once real data arrives. Worse, the naive fix —
 * chunking the list at exactly 100 — is *also* wrong whenever the statement binds anything else. A
 * `where("indexName", "=", name).where("id", "in", <100 ids>)` binds 101, and an `update … set(a, b)`
 * ahead of the list binds two more before a single id is counted.
 *
 * So the unit here is not "the cap" but **the budget left after the statement's own fixed parameters**.
 * A call site names how many parameters its statement binds besides the list, and the chunk size is
 * derived. Adding a `where` to one of those queries is then a one-number edit next to it, not a silent
 * re-break of a limit nobody re-derived.
 *
 * Lives in core rather than in each capability because the arithmetic is the part that was got wrong,
 * and because `data/` is already where D1's quirks live (see `withD1Retry`).
 */

/** D1's hard cap on bound parameters in one statement. Cloudflare documents it; over it is an error, not a truncation. */
export const MAX_BOUND_PARAMETERS = 100;

/**
 * How many list values one statement may still bind once its fixed parameters are paid for.
 *
 * `fixed` is everything the statement binds that is *not* part of the chunked list — each `where` value,
 * each `set` column, each limit. Throws when a statement leaves no room at all: that is a bug in the
 * query, not a runtime condition, and silently returning zero would spin the caller's loop forever.
 */
export function boundParameterBudget(fixed: number): number {
  if (!Number.isInteger(fixed) || fixed < 0) {
    throw new InternalError({
      message: "Something unexpected happened.",
      detail: `boundParameterBudget requires a non-negative integer count of fixed parameters; got ${fixed}.`,
    });
  }
  const budget = MAX_BOUND_PARAMETERS - fixed;
  if (budget < 1) {
    throw new InternalError({
      message: "Something unexpected happened.",
      detail: `A statement binding ${fixed} fixed parameters leaves no room under D1's cap of ${MAX_BOUND_PARAMETERS}.`,
    });
  }
  return budget;
}

/**
 * Split `values` into chunks, each small enough that one statement binding `fixed` other parameters
 * stays under D1's cap. An empty input yields no chunks, so a caller's loop simply does not run.
 */
export function chunkByBoundParameters<T>(values: readonly T[], fixed: number): T[][] {
  const size = boundParameterBudget(fixed);
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) chunks.push(values.slice(start, start + size));
  return chunks;
}

/**
 * Split `rows` into chunks small enough that one multi-row `insert` stays under D1's cap.
 *
 * The sibling of {@link chunkByBoundParameters}, and a separate function because the arithmetic is
 * genuinely different: an `in (…)` list binds **one** parameter per value, while an insert binds one
 * per *column* per row. Reusing the list chunker for an insert silently allows `columns` times too
 * many rows, which is a bug that passes every small test and only appears once real data arrives —
 * `@pithy-sh/support` shipped exactly that, capping attachments at 10 rows of 11 columns and losing
 * every one of them to `too many SQL variables`.
 */
export function chunkRowsByBoundParameters<T>(rows: readonly T[], columnsPerRow: number, fixed = 0): T[][] {
  if (!Number.isInteger(columnsPerRow) || columnsPerRow < 1) {
    throw new InternalError({
      message: "Something unexpected happened.",
      detail: `chunkRowsByBoundParameters requires a positive column count; got ${columnsPerRow}.`,
    });
  }
  const size = Math.floor(boundParameterBudget(fixed) / columnsPerRow);
  if (size < 1) {
    throw new InternalError({
      message: "Something unexpected happened.",
      detail: `A row of ${columnsPerRow} columns cannot fit under D1's cap of ${MAX_BOUND_PARAMETERS}.`,
    });
  }
  const chunks: T[][] = [];
  for (let start = 0; start < rows.length; start += size) chunks.push(rows.slice(start, start + size));
  return chunks;
}

/** Read a property off a platform object without losing its `this` — workerd's D1 objects need it. */
function passThrough(target: object, property: PropertyKey): unknown {
  const value = Reflect.get(target, property);
  return typeof value === "function" ? value.bind(target) : value;
}

/** Enough of a statement to name it in a failure, without carrying a query of unbounded length. */
function nameOf(query: string): string {
  const collapsed = query.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}…` : collapsed;
}

/**
 * D1, wrapped so a statement over the cap fails as **the rule** rather than as SQLite's complaint.
 *
 * `createDatabase` applies this to every database it builds, which is the whole point: the rule lives at
 * the thing being called, not at each of the query sites that call it. A capability written next month
 * that has never heard of the cap is covered by it, and so is one written last year — which matters,
 * because the list of sites that got this wrong has been wrong five times running. Four capabilities
 * bound past the cap while the arithmetic to avoid it sat in this file, unimported (#250).
 *
 * The check is at `bind`, because that is the only place the number is real: it is what the driver hands
 * the platform, after Kysely has compiled the statement and after any chunking a caller did. Anything
 * measured earlier measures intent.
 *
 * It does not chunk. It cannot — splitting an arbitrary statement is the caller's arithmetic, and
 * {@link chunkByBoundParameters} and {@link chunkRowsByBoundParameters} are where it belongs. What this
 * buys is that the failure names the rule that was broken, one statement before the platform says
 * `too many SQL variables` and leaves the author to work out which list was too long.
 */
export function guardBoundParameters(d1: D1Database): D1Database {
  return new Proxy(d1, {
    get(target, property) {
      if (property !== "prepare") return passThrough(target, property);
      return (query: string): D1PreparedStatement => {
        const statement = target.prepare(query);
        return new Proxy(statement, {
          get(inner, key) {
            if (key !== "bind") return passThrough(inner, key);
            // Returns the *real* bound statement, not another proxy: a bound statement is handed
            // straight to `D1Database.batch`, which is a platform call that will not take a wrapper.
            return (...values: unknown[]): D1PreparedStatement => {
              if (values.length > MAX_BOUND_PARAMETERS) {
                throw new InternalError({
                  message: "Something unexpected happened.",
                  action: "Retry. If it persists, the query needs chunking.",
                  detail: `A statement bound ${values.length} parameters; D1 accepts ${MAX_BOUND_PARAMETERS}. Chunk the list through chunkByBoundParameters (one parameter per value) or chunkRowsByBoundParameters (one per column per row). Statement: ${nameOf(query)}`,
                });
              }
              return inner.bind(...values);
            };
          },
        });
      };
    },
  });
}

/** What one recorded run bound, and whatever it threw. */
export interface BoundParameterRecording {
  /** Every parameter count D1 was asked to bind, in the order the statements ran. */
  counts: number[];
  /** What `run` threw, or `undefined`. Returned rather than propagated — see below. */
  error: unknown;
}

/**
 * Run `run` against a recording D1 and report every parameter count it bound.
 *
 * A gate wants to assert the ceiling *before* it rethrows, so the failure an author reads is the
 * invariant rather than whatever the platform said about it. Hence the throw comes back in the result
 * instead of propagating: the caller asserts the counts, then rethrows anything left.
 *
 * The counterpart to {@link guardBoundParameters} rather than a duplicate of it. The guard proves a
 * statement was *refused*; this proves what was *bound* — that chunks fill the budget rather than
 * creeping under it, and that chunking lost no rows on the way.
 */
export async function recordBoundParameters(
  d1: D1Database,
  run: (d1: D1Database) => Promise<void>,
): Promise<BoundParameterRecording> {
  const counts: number[] = [];
  const recorder = new Proxy(d1, {
    get(target, property) {
      if (property !== "prepare") return passThrough(target, property);
      return (query: string): D1PreparedStatement => {
        const statement = target.prepare(query);
        return new Proxy(statement, {
          get(inner, key) {
            if (key !== "bind") return passThrough(inner, key);
            return (...values: unknown[]): D1PreparedStatement => {
              counts.push(values.length);
              return inner.bind(...values);
            };
          },
        });
      };
    },
  });
  try {
    await run(recorder);
    return { counts, error: undefined };
  } catch (error) {
    return { counts, error };
  }
}
