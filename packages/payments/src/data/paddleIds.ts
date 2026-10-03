// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a Paddle id looks like, in one place per kind of id.
 *
 * **Extracted because the rule had five producers and no two of them agreed.** `rails/paddle/verify.ts`
 * held the transaction pattern as a module-private const, checking a receipt before spending a round trip
 * on it; the `_ptxn` reader in `../client/paddleLink.ts` needs the same question answered about a value out
 * of a query string (#680). Then `refund.ts`, `refresh.ts` and `subscription.ts` each answered it again
 * with `startsWith`, which accepts the bare prefix and an alphabet Paddle does not issue — so one string
 * was a transaction in `refund.ts` and not one in `verify.ts` (#681). A second regex is a second producer,
 * and the ones that drift are always the copies nobody knew were copies.
 *
 * **Two kinds, two patterns, one rule.** Paddle's ids are globally prefixed and distinct, so the prefix is
 * what says whether a row names a payment or the subscription it belongs to. Both predicates live here
 * because that is one rule read two ways, not two rules: a caller asking "is this a transaction" is asking
 * the question whose other half is "is this a subscription", and splitting them across modules is how the
 * next build ends up with a tight transaction check beside a loose subscription one.
 *
 * **Deliberately `+` rather than `{26}`.** Paddle's API reference documents the ids as `^txn_[a-z\d]{26}$`
 * and `^sub_[a-z\d]{26}$`, and every id seen from the live and sandbox accounts has been 26 characters
 * after the prefix. These stay looser than the documentation on purpose: the length is Paddle's to change,
 * a length that grew would make this kit reject transactions that are perfectly real, and nothing here
 * depends on the count. The prefix and the alphabet are what distinguish a transaction from a
 * subscription, a price or a URL, and they are what the callers actually need to know.
 *
 * **It lives in `data/` rather than in `rails/paddle/`, and the gate is why.** `client/sameOrigin.test.ts`
 * freezes every specifier a browser module may import, and the one existing crossing out of `src/client/`
 * is `wholeUnits.ts` reaching `../data/money` — permitted because that module imports nothing, so "a set of
 * currency codes reaches the bundle, no graph behind it". This is the same shape and earns its place the
 * same way: it imports nothing, so the browser half reaches a predicate and not a rail. Under
 * `rails/paddle/` it made a browser module read the server rail, which the gate refused and was right to.
 * **Nothing in this module may grow an import** — not a shared prefix constant, not a helper. The empty
 * list at `sameOrigin.test.ts`'s `"src/data/paddleIds.ts"` is the whole reason the crossing is allowed.
 *
 * `paddleIds.test.ts` beside this file is also the sweep that keeps these two patterns the only ones:
 * it fails when any other module in the package interrogates a Paddle id prefix.
 */
const TRANSACTION_ID = /^txn_[a-z0-9]+$/;

/** A subscription, the other half of the same rule. See the module doc for why both live here. */
const SUBSCRIPTION_ID = /^sub_[a-z0-9]+$/;

/**
 * Whether a value is shaped like a Paddle transaction id.
 *
 * Shape only. It says nothing about whether the transaction exists, who it belongs to, or what it is for —
 * a caller acting on any of that has to ask Paddle, and `verify.ts` is what does. This is the cheap check
 * that comes first.
 *
 * **`boolean`, deliberately, not `value is string`.** The predicate is the tempting signature and it makes
 * the *false* branch `never` for a caller whose value is already a string — which is every caller that
 * matters. `verify.ts` refuses a malformed receipt with a message naming `id.length`, and under a predicate
 * that line stopped compiling. Nothing here needs the narrowing: the one caller holding `string | null` has
 * already narrowed on `!== null` before asking, and Zod's `.refine` wants a boolean.
 */
export function isPaddleTransactionId(value: unknown): boolean {
  return typeof value === "string" && TRANSACTION_ID.test(value);
}

/**
 * Whether a value is shaped like a Paddle subscription id.
 *
 * Shape only, and `boolean` rather than a type predicate, for the reasons {@link isPaddleTransactionId}
 * gives — the three rail callers all hold a `string` already and want the false branch to stay reachable.
 *
 * The three callers read a purchase row's `providerTransactionId` and ask whether it names a subscription
 * rather than one of its payments: `refresh.ts` to decide which endpoint to re-read, twice, and
 * `subscription.ts` to decide whether there is a subscription to quote, change, cancel or keep at all.
 */
export function isPaddleSubscriptionId(value: unknown): boolean {
  return typeof value === "string" && SUBSCRIPTION_ID.test(value);
}
