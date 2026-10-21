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
 * - **A marked key**: a record keyed by a marked value, `Record<User["email"], …>`, is refused like the value.
 * - **A marked string as a message**: `log.info(user.email)`, `log.child(user.email)`, and `message`, `action` or
 *   `detail` on any `PithyError` constructor fail, because each takes {@link UnmarkedString}.
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

/**
 * Whether `T`, or anything up to `D` levels of object or array inside it, carries a privacy brand — in a value, or
 * in a key: a `Record<User["email"], number>` holds every email it is keyed by.
 */
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
              ? true extends IsMarked<keyof T>
                ? true
                : true extends { [K in keyof T]-?: ContainsMarked<T[K], Prev[D]> }[keyof T]
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
 * field is not. What a log message, a logger's name and `PithyError`'s `message`, `action` and `detail` take.
 */
export type UnmarkedString = string & NoPrivacyBrand;

/**
 * What `redact` (`./redact`) returns: the value's own type, with every marked part replaced by the
 * string its class masks it to.
 *
 * **It fails closed, as `redact` does.** A position is a masked `string` when any member of the union the schema
 * gives it is marked: `pii(z.string()) | z.number()` is `string`, and in `{ e: Email } | { e: number }` the field
 * `e` is `string` in both members, because `redact` masks the position whichever option the value came from.
 *
 * Each container stays the container it is, because that is what `redact` hands back at runtime: an array maps to an
 * array of its redacted elements — a branded `string[] & $brand<"Ids">` included, whose brand goes — keeping a
 * `readonly`, and a tuple maps position by position, keeping its length. A map or a set maps its keys and its
 * elements, which is where a `pii()` key comes back as a masked string. A plain object maps its fields, and a marked
 * key becomes `string`. The remaining {@link Opaque} values — an `Error`, a `Date`, a function — are copied as they
 * are.
 */
export type Redacted<T> = RedactedAt<T, T>;

/**
 * One member `T` of a position, redacted against `C`: every type the schema puts at that position, across every
 * union member. `C` decides whether the position is masked; `T` decides the shape a member keeps.
 */
type RedactedAt<T, C> =
  IsAny<T> extends true
    ? T
    : true extends IsMarked<C>
      ? string
      : T extends unknown
        ? T extends MaybeInstance<infer U>
          ? string | RedactedAt<U, C>
          : T extends readonly unknown[]
            ? IsTuple<T> extends true
              ? RedactedTuple<T, C>
              : T extends unknown[]
                ? RedactedAt<T[number], ElementOf<C>>[]
                : readonly RedactedAt<T[number], ElementOf<C>>[]
            : T extends Map<infer K, infer V>
              ? Map<RedactedAt<K, MapKeyOf<C>>, RedactedAt<V, MapValueOf<C>>>
              : T extends ReadonlyMap<infer K, infer V>
                ? ReadonlyMap<RedactedAt<K, MapKeyOf<C>>, RedactedAt<V, MapValueOf<C>>>
                : T extends Set<infer E>
                  ? Set<RedactedAt<E, SetElementOf<C>>>
                  : T extends ReadonlySet<infer E>
                    ? ReadonlySet<RedactedAt<E, SetElementOf<C>>>
                    : T extends Opaque
                      ? T extends MaskedWhenMarked
                        ? true extends CarriesMark<C>
                          ? string
                          : T
                        : T
                      : T extends object
                        ? { [K in keyof T as true extends IsMarked<K> ? string : K]: RedactedAt<T[K], FieldOf<C, K>> }
                        : T
        : never;

/**
 * The {@link Opaque} values `redact` masks whole where the position also holds a marked type: a `Date`, an `Error`,
 * any object it cannot walk into. A function is not an object to it, and is copied as it is.
 */
type MaskedWhenMarked = Error | Date | RegExp | PromiseLike<unknown>;

/** Whether any member of `C` carries a privacy brand, in a map's or a set's members as well. */
type CarriesMark<C> =
  true extends ContainsMarked<C>
    ? true
    : C extends ReadonlyMap<infer K, infer V>
      ? true extends ContainsMarked<K> | ContainsMarked<V>
        ? true
        : false
      : C extends ReadonlySet<infer E>
        ? ContainsMarked<E>
        : false;

/**
 * What `redact(schema, value)` returns: {@link Redacted} over the schema's output, where every position a transform
 * over a marked input fills is the masked `string` it is at runtime. A transform's output type says nothing about
 * where its input's marks went — a class instance, a renamed field — and `redact` masks it whole, so the type reads
 * the schema, not only its output: an object, an array, a set, a map, a record, a union, an intersection, a lazy and
 * every wrapper are followed to {@link PRIVACY_CHECK_DEPTH} levels, and any other kind keeps its output type.
 *
 * The marks are read off the schema too, because a codec's wire side and a pipe's input leave no brand on the output
 * type. A codec whose app side does not mark every path its wire side marks is a `string`, as `redact` masks it
 * whole; a plain pipe's input marks join its output's; a `z.instanceof` member of a position with a mark inside may be
 * the masked `string`. An `.overwrite()` is a check, which no type can see, so the object it overwrites keeps its type
 * though `redact` masks it whole.
 */
export type RedactedOutput<S> = Redacted<Revealed<S>>;

/**
 * A `z.instanceof` or `z.custom` member where a branch with a mark inside reaches the position. `redact` masks a class
 * instance there whole and walks a plain object, and the type cannot tell the two apart, so {@link Redacted} gives
 * this member as `string` or the type redacted. A box, not a brand: a brand would mask the whole position.
 */
type MaybeInstance<T> = { readonly "privacy:instance": T };

/** The brand a position {@link Revealed} masks whole carries, so {@link Redacted} turns it into a `string`. */
type MaskedWhole = string & { readonly [z.core.$brand]: { readonly "privacy:opaque": true } };

/** A schema kind, read off its definition. */
type DefOf<S> = S extends { readonly _zod: { readonly def: infer D } } ? D : never;

/** Whether a pipe's output side is opaque — a transform, a custom check, an `any` or an `unknown` — as `redact` reads it. */
type IsOpaqueOutput<S, D extends number = PRIVACY_CHECK_DEPTH> = [D] extends [never]
  ? false
  : DefOf<S> extends { type: "transform" | "custom" | "any" | "unknown" }
    ? true
    : DefOf<S> extends { type: "pipe"; out: infer O }
      ? IsOpaqueOutput<O, Prev[D]>
      : DefOf<S> extends {
            type: "optional" | "nullable" | "default" | "prefault" | "readonly" | "catch" | "nonoptional";
            innerType: infer I;
          }
        ? IsOpaqueOutput<I, Prev[D]>
        : DefOf<S> extends { type: "union"; options: readonly (infer O)[] }
          ? true extends (O extends unknown ? IsOpaqueOutput<O, Prev[D]> : never)
            ? true
            : false
          : DefOf<S> extends { type: "intersection"; left: infer L; right: infer R }
            ? true extends IsOpaqueOutput<L, Prev[D]> | IsOpaqueOutput<R, Prev[D]>
              ? true
              : false
            : DefOf<S> extends { type: "lazy"; getter: () => infer I }
              ? IsOpaqueOutput<I, Prev[D]>
              : false;

/** `parent.key`, or `key` at the root, as `classifyPrivacy` joins a path. */
type Join<P extends string, K extends string> = P extends "" ? K : `${P}.${K}`;

/** The privacy brand keys a type carries — `privacy:pii` — or `never`. */
type MarkKeys<T> = T extends { readonly [z.core.$brand]: infer M } ? Extract<keyof M, `privacy:${string}`> : never;

/**
 * Every marked path in a schema and its brand key, as `path|privacy:class` — the walk `classifyPrivacy` does, at the
 * type level, to {@link PRIVACY_CHECK_DEPTH} levels. A marked node is not descended into. A schema's output type
 * cannot say this: a codec's wire side, and a pipe's input, leave no brand on what it returns.
 */
type MarkedPaths<S, P extends string = "", D extends number = PRIVACY_CHECK_DEPTH> = [D] extends [never]
  ? never
  : IsAny<z.output<S>> extends true
    ? never
    : [MarkKeys<z.output<S>>] extends [never]
      ? DefOf<S> extends { type: "pipe"; in: infer I; out: infer O }
        ? MarkedPaths<I, P, Prev[D]> | MarkedPaths<O, P, Prev[D]>
        : DefOf<S> extends {
              type: "optional" | "nullable" | "default" | "prefault" | "readonly" | "catch" | "nonoptional";
              innerType: infer I;
            }
          ? MarkedPaths<I, P, Prev[D]>
          : DefOf<S> extends { type: "lazy"; getter: () => infer I }
            ? MarkedPaths<I, P, Prev[D]>
            : DefOf<S> extends { type: "union"; options: readonly (infer O)[] }
              ? O extends unknown
                ? MarkedPaths<O, P, Prev[D]>
                : never
              : DefOf<S> extends { type: "intersection"; left: infer L; right: infer R }
                ? MarkedPaths<L, P, Prev[D]> | MarkedPaths<R, P, Prev[D]>
                : DefOf<S> extends { type: "array"; element: infer E }
                  ? MarkedPaths<E, `${P}[]`, Prev[D]>
                  : DefOf<S> extends { type: "set"; valueType: infer E }
                    ? MarkedPaths<E, `${P}[]`, Prev[D]>
                    : DefOf<S> extends { type: "tuple"; items: infer Items extends readonly unknown[]; rest: infer R }
                      ?
                          | {
                              [K in keyof Items & `${number}`]: MarkedPaths<Items[K], `${P}[${K}]`, Prev[D]>;
                            }[keyof Items & `${number}`]
                          | MarkedPaths<R, `${P}[]`, Prev[D]>
                      : DefOf<S> extends { type: "record" | "map"; keyType: infer K; valueType: infer V }
                        ? MarkedPaths<K, Join<P, "<key>">, Prev[D]> | MarkedPaths<V, Join<P, "*">, Prev[D]>
                        : DefOf<S> extends { type: "object"; shape: infer Shape; catchall?: infer C }
                          ?
                              | {
                                  [K in keyof Shape & string]: MarkedPaths<Shape[K], Join<P, K>, Prev[D]>;
                                }[keyof Shape & string]
                              | MarkedPaths<C, Join<P, "*">, Prev[D]>
                          : never
      : `${P}|${MarkKeys<z.output<S>>}`;

/** Whether a schema carries a mark anywhere: on a codec's wire side and a pipe's input as well as its output. */
type SchemaMarked<S> = [MarkedPaths<S>] extends [never] ? false : true;

/** Whether one schema marks a path, with a class, that the other does not: what a codec's decode could hide. */
type HidesMarks<I, O> = [Exclude<MarkedPaths<I>, MarkedPaths<O>>] extends [never] ? false : true;

/** A codec's definition: a pipe whose decode is a function. A plain pipe's `transform` is optional and absent. */
type CodecDef = { type: "pipe"; transform: (...args: never[]) => unknown };

/**
 * A schema's output, with every position a transform over a marked input fills replaced by {@link MaskedWhole}. `P` is
 * the outermost schema at this position: a union's or an intersection's options, a pipe's sides and every wrapper are
 * the same position, so they keep it, and a field, an element or a value starts its own.
 */
type Revealed<S, D extends number = PRIVACY_CHECK_DEPTH, P = S> = [D] extends [never]
  ? z.output<S>
  : IsAny<z.output<S>> extends true
    ? z.output<S>
    : true extends IsMarked<z.output<S>>
      ? z.output<S>
      : DefOf<S> extends { type: "pipe"; in: infer I; out: infer O }
        ? IsOpaqueOutput<O> extends true
          ? SchemaMarked<I> extends true
            ? MaskedWhole
            : z.output<S>
          : DefOf<S> extends CodecDef
            ? HidesMarks<I, O> extends true
              ? MaskedWhole
              : Revealed<O, Prev[D], P>
            : HidesMarks<I, O> extends true
              ? Revealed<O, Prev[D], P> | Revealed<I, Prev[D], P>
              : Revealed<O, Prev[D], P>
        : DefOf<S> extends { type: "custom" }
          ? // A class instance where a branch with a mark inside reaches it is masked whole; a plain object is walked.
            SchemaMarked<P> extends true
            ? MaybeInstance<z.output<S>>
            : z.output<S>
          : DefOf<S> extends { type: "optional"; innerType: infer I }
            ? Revealed<I, Prev[D], P> | undefined
            : DefOf<S> extends { type: "nullable"; innerType: infer I }
              ? Revealed<I, Prev[D], P> | null
              : DefOf<S> extends { type: "default" | "nonoptional"; innerType: infer I }
                ? Exclude<Revealed<I, Prev[D], P>, undefined>
                : DefOf<S> extends { type: "prefault" | "catch"; innerType: infer I }
                  ? Revealed<I, Prev[D], P>
                  : DefOf<S> extends { type: "lazy"; getter: () => infer I }
                    ? Revealed<I, Prev[D], P>
                    : DefOf<S> extends { type: "union"; options: readonly (infer O)[] }
                      ? O extends unknown
                        ? Revealed<O, Prev[D], P>
                        : never
                      : DefOf<S> extends { type: "intersection"; left: infer L; right: infer R }
                        ? Revealed<L, Prev[D], P> & Revealed<R, Prev[D], P>
                        : DefOf<S> extends { type: "array"; element: infer E }
                          ? Revealed<E, Prev[D]>[]
                          : DefOf<S> extends { type: "set"; valueType: infer E }
                            ? Set<Revealed<E, Prev[D]>>
                            : DefOf<S> extends { type: "map"; keyType: infer K; valueType: infer V }
                              ? Map<Revealed<K, Prev[D]>, Revealed<V, Prev[D]>>
                              : DefOf<S> extends { type: "record"; valueType: infer V }
                                ? { [P in keyof z.output<S>]: Revealed<V, Prev[D]> }
                                : DefOf<S> extends { type: "object"; shape: infer Shape }
                                  ? {
                                      [P in keyof z.output<S>]: P extends keyof Shape
                                        ? Revealed<Shape[P], Prev[D]>
                                        : z.output<S>[P];
                                    }
                                  : z.output<S>;

/**
 * A tuple's positions, redacted. A mapped type over a type parameter is homomorphic, so a tuple keeps its length and
 * its `readonly`; the key-remapping one {@link RedactedAt} uses for an object would turn it into a plain object.
 */
type RedactedTuple<T extends readonly unknown[], C> = { [K in keyof T]: RedactedAt<T[K], IndexOf<C, K>> };

/**
 * Whether an array type is a tuple: a fixed length, or a first position of its own (`[number, ...string[]]`). A plain
 * array — a branded one included — has neither.
 */
type IsTuple<T extends readonly unknown[]> = number extends T["length"] ? ("0" extends keyof T ? true : false) : true;

/** Every type an array or a tuple member of `C` holds as an element. */
type ElementOf<C> = C extends readonly (infer E)[] ? E : never;

/** Every type a member of `C` holds at tuple position `K`, or as any element of an array. */
type IndexOf<C, K> = C extends readonly unknown[] ? (K extends keyof C ? C[K] : C[number]) : never;

/** Every type a map member of `C` holds as a key, and as a value. */
type MapKeyOf<C> = C extends ReadonlyMap<infer K, unknown> ? K : never;
type MapValueOf<C> = C extends ReadonlyMap<unknown, infer V> ? V : never;

/** Every type a set member of `C` holds. */
type SetElementOf<C> = C extends ReadonlySet<infer E> ? E : never;

/** Every type an object member of `C` holds at field `K`. */
type FieldOf<C, K> = C extends readonly unknown[] | Opaque
  ? never
  : C extends object
    ? K extends keyof C
      ? C[K]
      : never
    : never;
