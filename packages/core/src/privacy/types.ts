// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";

/**
 * **The type gate: a marked value does not compile into a log, an audit record or an error detail** (#132).
 *
 * A marker brands a field's output type under the `privacy:` key (`./classes`). These types are what read
 * that brand on the three internal surfaces — the logger's fields, `AuditEvent.metadata`, `PithyError.detail`
 * — and refuse it at compile time, where the mistake is a red build rather than a row in an adopter's D1 that
 * nobody can retract.
 *
 * ## What the compiler checks, exactly
 *
 * - **A marked value itself**, anywhere a field value goes: `log.info("m", { email: user.email })` fails.
 * - **A marked value inside an object or an array, down to {@link PRIVACY_CHECK_DEPTH} levels below the field**:
 *   `{ user }`, `{ user: { email } }`, `{ users: [user] }`, `{ batch: { users: [user] } }` all fail.
 * - **`detail: email`** on any `PithyError` constructor fails, because `detail` takes {@link UnmarkedString}.
 *
 * ## What it does not, and cannot
 *
 * - **Deeper than {@link PRIVACY_CHECK_DEPTH}.** The bound is there so the walk terminates on a recursive type
 *   (a JSON alias, a tree), not for speed: measured with `tsc --extendedDiagnostics` (TypeScript 7.0.2,
 *   2026-10-20, #132), the gate costs `@pithy-sh/auth` +0.6% types and +0.1% instantiations over `main`, and
 *   moving the bound from 1 to 9 changes either count by less than 0.01% on every package — and by about 330
 *   types and 5,400 instantiations on a file that logs a Hono `Context`, a `Kysely` instance and an
 *   eight-level object, because `Error`, functions, promises, maps and sets are not walked. Below the bound a
 *   value is not inspected.
 * - **A template literal.** `` `signup for ${email}` `` is a `string` to TypeScript, whatever was
 *   interpolated, and no type can see through it. `detail` is where this matters most; interpolate the
 *   `redact`ed value, or the id, instead.
 * - **A cast or an `unknown`.** A value the compiler cannot see is a value it cannot refuse.
 *
 * None of the three is checked at runtime either: a marker changes no runtime value, so a string that
 * escaped the type is an ordinary string. `docs/PRIVACY.md` says the same to adopters.
 */

/** How many levels of object or array below a field value the gate inspects. See the module note. */
export type PRIVACY_CHECK_DEPTH = 6;

/** Depth countdown: `Prev[3]` is `2`. Index past the end is `never`, which stops the walk. */
type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** `true` for `any`, so an untyped value is never mistaken for a marked one. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * Values whose structure is not data: walking an `Error`'s payload union or a `Request`'s methods would cost the
 * compiler a great deal and could only ever find a brand somebody put there by hand.
 */
type Opaque =
  | Error
  | Date
  | RegExp
  | ((...args: never[]) => unknown)
  | PromiseLike<unknown>
  | ReadonlyMap<unknown, unknown>
  | ReadonlySet<unknown>;

/** Whether `T` carries a privacy brand. Distributes, so `marked | undefined` is `boolean` — test with `true extends`. */
export type IsMarked<T> =
  IsAny<T> extends true
    ? false
    : T extends { readonly [z.core.$brand]: infer M }
      ? [Extract<keyof M, `privacy:${string}`>] extends [never]
        ? false
        : true
      : false;

/** Whether `T`, or anything up to `D` levels of object or array inside it, carries a privacy brand. */
export type ContainsMarked<T, D extends number = PRIVACY_CHECK_DEPTH> =
  IsAny<T> extends true
    ? false
    : [D] extends [never]
      ? false
      : true extends IsMarked<T>
        ? true
        : T extends Opaque
          ? false
          : T extends readonly (infer E)[]
            ? ContainsMarked<E, Prev[D]>
            : T extends object
              ? true extends { [K in keyof T]-?: ContainsMarked<T[K], Prev[D]> }[keyof T]
                ? true
                : false
              : false;

/**
 * The type a refused field takes, so the compiler's error reads as the rule: `Type 'string & $brand<…>' is not
 * assignable to type '"A value marked with a privacy class …"'`.
 */
export type PrivateValueRefused =
  "A value marked with a privacy class cannot reach a log, an audit record or an error detail. Pass redact(Schema, value), or an unmarked field, instead.";

/**
 * A record of fields, each one either kept as written or refused because it holds a marked value. A surface
 * that accepts structured fields takes `F & Loggable<F>`: `F` infers from the call, and `Loggable<F>` replaces
 * every field that carries a brand with {@link PrivateValueRefused}, so the call fails on that key alone.
 */
export type Loggable<F> = { [K in keyof F]: true extends ContainsMarked<F[K]> ? PrivateValueRefused : F[K] };

/** No privacy brand. Any other brand — an adopter's `UserId` — is untouched. */
type NoPrivacyBrand = { readonly [z.core.$brand]?: { readonly [K in `privacy:${string}`]?: never } };

/**
 * A string that is not marked. A plain `string` and a template literal both are; `user.email` from a `pii()`
 * field is not. What `PithyError.detail` takes.
 */
export type UnmarkedString = string & NoPrivacyBrand;

/**
 * What `redact` (`./redact`) returns: the value's own type, with every marked part replaced by the
 * string its class masks it to.
 */
export type Redacted<T> =
  IsAny<T> extends true
    ? T
    : T extends unknown
      ? IsMarked<T> extends true
        ? string
        : T extends Opaque
          ? T
          : T extends object
            ? { [K in keyof T]: Redacted<T[K]> }
            : T
      : never;
