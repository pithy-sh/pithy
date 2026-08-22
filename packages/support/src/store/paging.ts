// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The inbox page bounds, in the one module that has no reason to import anything (#430).
 *
 * `http/schemas.ts` bounds a caller's `limit` with the same number the reader clamps to, and it used to
 * read it out of `store/threads.ts` — the Kysely reader, which brings `kysely`, `kysely-d1` and
 * `@cloudflare/workers-types` with it. A request schema is a client's business: a management client
 * building a call must be able to compile the shape it may send, in a browser, with no Worker types in
 * reach. So the two numbers moved and the reader kept the query.
 *
 * **Both moved, not only the one the schema needs.** They are read together — a default clamped into a
 * maximum, on one line, in two queries — and a pair split across two modules is how the next person
 * picks the wrong one.
 */

/** How many threads a page holds by default. */
export const DEFAULT_PAGE_SIZE = 25;

/** The most a caller may ask for in one page. */
export const MAX_PAGE_SIZE = 100;
