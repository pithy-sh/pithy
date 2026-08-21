// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The one payments subject kind support reads.
 *
 * `@pithy-sh/payments` keys a purchase on a **subject pair** — a user or an organization, plus an id —
 * and which of the two a project uses is its `billingSubject` config. Support cannot honour that choice.
 * It starts from a `From:` header, resolves it to a *person*, and does its billing lookup at thread-read
 * time, where there is no Hono `Context` to hand the adopter's subject resolver: the seam's whole job is
 * to answer "which organization is *this caller* acting for", and a support thread has no caller. So the
 * lookups in `link/sender.ts` filter on `user`, and `http/responses.ts` declares that on every response.
 *
 * ## Why this is its own module and not a constant in either of them
 *
 * It was `link/sender.ts`'s, and #418 imported it from `http/responses.ts` to build `SenderBillingScope`
 * off it — one line, one string, and the correct instinct: the value the `WHERE` clause filters on and
 * the value a console is told must be the same value. What came with it was `sender.ts`'s import list,
 * which is the server data layer: `@pithy-sh/auth`'s Kysely builder, `@pithy-sh/payments`' table map,
 * D1. A response schema is a module a browser imports — that is the whole reason §HTTP makes a response
 * a Zod object rather than an interface — and the adopter's client program stopped compiling on
 * `Cannot find name 'D1Database'` in a file it had never heard of (#419).
 *
 * So the constant lives where neither half owns it, and imports nothing. Both halves name it, neither
 * reaches the other, and widening it is still the single edit it was: one literal, breaking every
 * consumer that has not decided what an organization's panel should render, which is the correct amount
 * of friction for that change.
 *
 * `tooling/browser-scopes` holds the rule this module is an instance of: a module a browser may import
 * reaches no module that needs the Workers runtime.
 */
export const SUPPORT_BILLING_SCOPE = "user" as const;
