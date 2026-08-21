// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The compile-time half of "a secrets read must not be able to disclose a value".
 *
 * Two shapes make that promise — the reader shapes in `admin/status.ts` and the wire shapes in
 * `http/responses.ts` — and both keep it the same way: by being **incapable** of carrying a value
 * rather than by omitting one. `admin/status.ts` §The one constraint everything here is arranged around
 * makes the argument in full; this module is only the type it turns on.
 *
 * ## Why it is not declared in either of them
 *
 * It was `admin/status.ts`'s, and `http/responses.ts` imported it from there — a type-only import, so
 * nothing was in the bundle and nothing was wrong at runtime. It was still wrong for the compiler.
 * `admin/status.ts` is a Kysely reader: it names `SecretsStatusDb`, reaches `@pithy-sh/core/src/data/db`,
 * and through it `D1Database`. A response schema is a module a browser imports, so naming a *type* in
 * the reader put the whole D1 layer in the browser program's file set — one bare Workers global away
 * from the compile error `@pithy-sh/support` actually shipped (#419). Type-only or not, an edge the
 * compiler follows is an edge.
 *
 * So the type lives where neither half owns it, and imports nothing. (Jim, 2026-08-21.)
 *
 * `tooling/browser-scopes` holds the rule: a module a browser may import reaches no module that needs
 * the Workers runtime.
 */

/**
 * Field names that would carry a secret's value, the envelope around it, or free text written where a
 * value is in scope. Named as a type so the tripwires that use it are a list somebody has to delete
 * from rather than a rule somebody has to remember.
 */
type ValueBearing = "encryptedValue" | "iv" | "value" | "plaintext" | "metadataSnapshot" | "errorMessage";

/**
 * `true` when `T` names none of {@link ValueBearing}, and `never` when it names any — so an assignment
 * of `true` to this type stops compiling the moment a shape is widened.
 *
 * The tuple wrapper is not decoration: a bare `Extract<...> extends never` on a union would distribute
 * and answer `true` for every member, which is the one way this check could quietly pass.
 */
export type CarriesNoValue<T> = [Extract<keyof T, ValueBearing>] extends [never] ? true : never;
