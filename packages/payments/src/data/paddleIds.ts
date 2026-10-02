// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * What a Paddle transaction id looks like, in one place.
 *
 * **Extracted because it had two callers coming and this repository has paid four times for a rule that
 * lived at a call site.** `rails/paddle/verify.ts` held this pattern as a module-private const, checking
 * a receipt before spending a round trip on it. The `_ptxn` reader in `../client/paddleLink.ts` needs the
 * same question answered about a value out of a query string. A second regex would be a second producer, and
 * the ones that drift are always the copies nobody knew were copies.
 *
 * **Deliberately `+` rather than `{26}`.** Paddle's API reference documents the id as `^txn_[a-z\d]{26}$`
 * and every id seen from the live and sandbox accounts has been 26 characters after the prefix. This stays
 * looser than the documentation on purpose: the length is Paddle's to change, a length that grew would
 * make this kit reject transactions that are perfectly real, and nothing here depends on the count. The
 * prefix and the alphabet are what distinguish a transaction from a subscription, a price or a URL, and
 * they are what the two callers actually need to know.
 *
 * **It lives in `data/` rather than in `rails/paddle/`, and the gate is why.** `client/sameOrigin.test.ts`
 * freezes every specifier a browser module may import, and the one existing crossing out of `src/client/`
 * is `wholeUnits.ts` reaching `../data/money` — permitted because that module imports nothing, so "a set of
 * currency codes reaches the bundle, no graph behind it". This is the same shape and earns its place the
 * same way: it imports nothing, so the browser half reaches a predicate and not a rail. Under
 * `rails/paddle/` it made a browser module read the server rail, which the gate refused and was right to.
 */
const TRANSACTION_ID = /^txn_[a-z0-9]+$/;

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
