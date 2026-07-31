// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

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
