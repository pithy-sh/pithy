// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * Keyset pagination, once, for every capability that lists an unbounded table.
 *
 * ## Why keyset and never offset
 *
 * `OFFSET` shifts under a client whenever a row is inserted, and every table these paginate — audit
 * events, email jobs, users, ledger transactions — is written to constantly while somebody is reading
 * it. With `OFFSET 25` a row inserted at the head pushes one row from page 1 onto page 2, so a client
 * paging through sees it twice and misses nothing only by luck; a deletion drops a row entirely. A
 * keyset cursor names the last row's sort position, so the next page starts exactly where the previous
 * ended whatever happened in between.
 *
 * ## Why this is in core rather than copied
 *
 * `@pithy-sh/support` had the only implementation, and Part 3 of #89 needs the same thing in four more
 * packages. Four copies of a security-adjacent decode — where the difference between "malformed cursor"
 * and "500" is a caller's ability to probe — is four places for one of them to be wrong. Capabilities
 * depend on core seams, which is exactly what this is.
 *
 * ## The shape of a page
 *
 * A caller asks for `limit`; the query fetches `limit + 1` and, when it gets them, drops the extra and
 * returns a `nextCursor`. That is what makes "is there another page" answerable **without a count
 * query**, which on an audit table is the difference between a page load and a table scan.
 */

/** A sensible page when a caller names none. Small enough to render, large enough to be one request. */
export const DEFAULT_PAGE_SIZE = 25;

/** The most a caller may ask for in one page, whatever they send. An unbounded page is a table scan. */
export const MAX_PAGE_SIZE = 100;

/**
 * The `limit` a query should actually use, clamped into range.
 *
 * Clamped rather than rejected: a client asking for 1000 wants "as many as you'll give me", and failing
 * the request teaches it nothing a capped page does not. A caller asking for 0 or a negative gets one
 * row rather than an empty page that looks like the end of the list.
 */
export function pageLimit(requested: number | undefined): number {
  return Math.min(Math.max(requested ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

/**
 * An opaque position in a descending `(sort, id)` ordering.
 *
 * `sort` is the primary column's value — a ms-epoch for a date, a number for a monotonic id. `id` is the
 * tiebreak that makes the position exact: without it, two rows sharing a timestamp straddle a page
 * boundary and one of them is skipped or repeated.
 */
export const PageCursor = z
  .object({
    sort: z
      .union([z.number(), z.string()])
      .describe(
        "The sort column's value on the last row of the previous page — a ms-epoch for a date column, a number for a monotonic id, a string for an ISO-8601 date column. A string and a number compare differently in SQLite, so this carries whichever the column actually stores.",
      ),
    id: z
      .union([z.number(), z.string()])
      .describe(
        "That row's primary key, the tiebreak that makes the position exact. Two rows sharing a sort value would otherwise straddle a page boundary, and one of them would be skipped or returned twice.",
      ),
  })
  .describe("An opaque position in a descending (sort, id) ordering — where the next page starts.");
export type PageCursor = z.infer<typeof PageCursor>;

/**
 * Encode a cursor for the wire.
 *
 * Base64url over JSON, and **opaque by intent rather than by obscurity**: the point is that a client
 * cannot construct one by hand and therefore cannot come to depend on its shape, so the ordering can
 * change later without breaking every caller. It is not a secret — it holds a sort value and an id the
 * caller was just given, both of which were in the page it came from.
 */
export function encodeCursor(cursor: PageCursor): string {
  // UTF-8 first. `btoa` throws `InvalidCharacterError` on any code unit above U+00FF, and a cursor's
  // `id` can be a caller-minted string — a device id, an external reference — so a single non-Latin-1
  // character would turn a page boundary into a 500 rather than a cursor.
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode a cursor. Returns undefined for anything malformed.
 *
 * **A bad cursor is a first page, not a 500.** Cursors travel through URLs, get truncated by clients,
 * and outlive deploys; treating a malformed one as an error turns an ordinary client bug into a page
 * that never loads, and hands anyone probing the endpoint a way to tell a parse failure from a
 * not-found. Every failure mode here — bad base64, bad JSON, wrong shape — collapses to the same
 * undefined.
 */
export function decodeCursor(value: string | undefined): PageCursor | undefined {
  if (!value) return undefined;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = PageCursor.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Split an over-fetched result into the page and the cursor that follows it.
 *
 * Pass the rows a query returned when asked for `limit + 1`. When there are more than `limit`, the extra
 * is dropped and `nextCursor` names the last row of the page; otherwise `nextCursor` is null and the
 * client knows it has reached the end without a second request.
 */
export function toPage<T>(
  rows: readonly T[],
  limit: number,
  position: (row: T) => PageCursor,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last !== undefined ? encodeCursor(position(last)) : null };
}
