// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The segment cap, in the one module that has no reason to import anything (#430).
 *
 * `http/schemas.ts` states the same bound a caller is refused by, so it needs this number — and it used
 * to reach it through `rank/query.ts`, which builds the SQL and therefore pulls Kysely, `kysely-d1` and
 * `@cloudflare/workers-types` behind it. A request schema is a client's business: a management client
 * building a call must be able to compile the shape it may send, in a browser, with no Worker types in
 * reach. So the number moved and the query kept the query.
 *
 * **The relationship this number only means something against lives elsewhere, on purpose.**
 * `boundParameterBudget` is in `@pithy-sh/core/src/data/boundParameters`, which imports `D1Database` for
 * the guard beside it, so importing it here would put the data layer back under a browser program by a
 * shorter route. `rank/query.workers.test.ts` asserts `MAX_SEGMENT_SIZE <=
 * boundParameterBudget(SEGMENT_FIXED_PARAMETERS)` where the budget is already in scope, and that
 * assertion is what ties these two constants to D1's ceiling. Moving them without it detaches the cap
 * from the limit it exists for, which is #250 with no symptom until real data arrives.
 */

/**
 * What a segment query binds besides the members: 4 filters (boardId, windowKey, visible, hidden) plus
 * the 6 of `betterThan` (score twice, achieved_at twice, score and userId again). `rankOf` within a
 * segment is the tightest path, so its overhead is the one that sets the cap.
 */
export const SEGMENT_FIXED_PARAMETERS = 10;

/**
 * Cap on a segment's member count.
 *
 * `boundParameterBudget(SEGMENT_FIXED_PARAMETERS)` is 90 — the most D1 would take. 80 is deliberately
 * inside it, so that adding one more filter to a segment query is a change to `rank/query.ts` rather
 * than a change to what every caller may pass. `segmentMembers` asserts the relationship rather than
 * trusting it, and `boundParameters.test.ts` in core owns the arithmetic itself.
 */
export const MAX_SEGMENT_SIZE = 80;
