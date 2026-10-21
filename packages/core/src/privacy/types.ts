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

/**
 * How many levels of schema {@link RedactedOutput} reads, structure and opaque insides alike. Deeper than the gate,
 * because a mark seven levels inside a JSON column is masked by `redact` and must be typed the same.
 */
export type REDACT_TYPE_DEPTH = 16;

/** Depth countdown: `Prev[3]` is `2`. Index past the end is `never`, which stops the walk. */
type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

/** One level down from `D`, and `never` from `never`: indexing {@link Prev} with `never` is not `never`. */
type Down<D extends number> = [D] extends [never] ? never : Prev[D];

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
            ? ContainsMarked<E, Down<D>>
            : T extends object
              ? true extends IsMarked<keyof T>
                ? true
                : true extends { [K in keyof T]-?: ContainsMarked<T[K], Down<D>> }[keyof T]
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
 * A value's own type with every marked part replaced by the string `redact` masks it to, read off the type alone:
 * the type a caller names for a value it already redacted, `Redacted<User>`. `redact` itself returns
 * {@link RedactedOutput}, which reads the schema and agrees with this wherever the schema's output says enough.
 *
 * **It fails closed, as `redact` does.** A position is a masked `string` when any member of the union the type gives
 * it is marked: `pii(z.string()) | z.number()` is `string`, and in `{ e: Email } | { e: number }` the field `e` is
 * `string` in both members. An array maps to an array of its redacted elements, a tuple keeps its length, a plain
 * object maps its fields, and a marked key becomes `string`. A map, a set or a promise holding a mark is a masked
 * `string`, because `redact` masks one whole; one holding none, and any other {@link Opaque} value, is kept as it is.
 *
 * **It is coarse where it cannot be sure.** It reads {@link REDACT_TYPE_DEPTH} levels; a position below that which may
 * still hold a mark is `unknown`, and so is `any`. Narrow it yourself where you know more.
 */
export type Redacted<T> = RedactedAt<T, T, REDACT_TYPE_DEPTH>;

/**
 * One member `T` of a position, redacted against `C`: every type at that position, across every union member. `C`
 * decides whether the position is masked; `T` decides the shape a member keeps. `D` is the depth left to read.
 */
type RedactedAt<T, C, D extends number> =
  IsAny<T> extends true
    ? unknown
    : true extends IsMarked<C>
      ? string | Extract<T, null | undefined>
      : Verdict<MarkIn<C, D>> extends false
        ? T
        : [D] extends [never]
          ? unknown
          : T extends unknown
            ? T extends readonly unknown[]
              ? IsTuple<T> extends true
                ? RedactedTuple<T, C, D>
                : T extends unknown[]
                  ? RedactedAt<T[number], ElementOf<C>, Down<D>>[]
                  : readonly RedactedAt<T[number], ElementOf<C>, Down<D>>[]
              : T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> | PromiseLike<unknown>
                ? string
                : T extends Opaque
                  ? T
                  : T extends object
                    ? {
                        [K in keyof T as true extends IsMarked<K> ? string : K]: RedactedAt<
                          T[K],
                          FieldOf<C, K>,
                          Down<D>
                        >;
                      }
                    : T
            : never;

/** A search's answer: `true` when a mark was found, `"deep"` when none was but the search ran out of depth. */
type Verdict<R> = true extends R ? true : "deep" extends R ? "deep" : false;

/**
 * Whether any member of `C`, or anything up to `D` levels inside it, carries a privacy brand: in a value, a key, a
 * map's or a set's members, or a promise. `"deep"` where the depth ran out on something that could still hold one.
 */
type MarkIn<C, D extends number> =
  IsAny<C> extends true
    ? false
    : C extends unknown
      ? true extends IsMarked<C>
        ? true
        : C extends ReadonlyMap<infer K, infer V>
          ? MarkIn<K, Down<D>> | MarkIn<V, Down<D>>
          : C extends ReadonlySet<infer E>
            ? MarkIn<E, Down<D>>
            : C extends PromiseLike<infer P>
              ? MarkIn<P, Down<D>>
              : C extends Opaque
                ? false
                : C extends object
                  ? [D] extends [never]
                    ? "deep"
                    : true extends IsMarked<keyof C>
                      ? true
                      : C extends readonly (infer E)[]
                        ? MarkIn<E, Down<D>>
                        : { [K in keyof C]-?: MarkIn<C[K], Down<D>> }[keyof C] | false
                  : false
      : never;

/**
 * A tuple's positions, redacted. A mapped type over a type parameter is homomorphic, so a tuple keeps its length and
 * its `readonly`; the key-remapping one {@link RedactedAt} uses for an object would turn it into a plain object.
 */
type RedactedTuple<T extends readonly unknown[], C, D extends number> = {
  [K in keyof T]: RedactedAt<T[K], IndexOf<C, K>, Down<D>>;
};

/**
 * Whether an array type is a tuple: a fixed length, or a first position of its own (`[number, ...string[]]`). A plain
 * array — a branded one included — has neither.
 */
type IsTuple<T extends readonly unknown[]> = number extends T["length"] ? ("0" extends keyof T ? true : false) : true;

/** Every type an array or a tuple member of `C` holds as an element. */
type ElementOf<C> = C extends readonly (infer E)[] ? E : never;

/** Every type a member of `C` holds at tuple position `K`, or as any element of an array. */
type IndexOf<C, K> = C extends readonly unknown[] ? (K extends keyof C ? C[K] : C[number]) : never;

/** Every type an object member of `C` holds at field `K`. */
type FieldOf<C, K> = C extends readonly unknown[] | Opaque
  ? never
  : C extends object
    ? K extends keyof C
      ? C[K]
      : never
    : never;

/**
 * **What `redact(schema, value)` returns, read off the schema: the rule `redact` and `classifyPrivacy` share**
 * (`./classify`), at the type level.
 *
 * - **A marked position is a `string`**: a marked node, or any option or side of one that is.
 * - **An opaque node with a mark anywhere inside it is a `string`** — a transform, a pipe, a preprocess, a codec
 *   (`sqliteJson` too), a `z.custom`, a set, a map, a promise, a function — because `redact` masks it whole. With no
 *   mark inside it keeps its output type, unless something else at its position carries a mark: then a transform, an
 *   `unknown`, a custom or a coercion beside it holds the same value, and the position is a `string`. A scalar never
 *   is, and a coercion is not a scalar.
 * - **A structural node keeps its shape**: an object maps its fields, an array stays an array — a branded one
 *   included, whose brand goes — a tuple keeps its positions and its rest, a record maps its values and turns a
 *   marked key into `string`, and every wrapper keeps the `undefined` or the `null` it adds. A union is a union of its
 *   members, each with every option's marks at each position; an intersection intersects its sides the same way.
 * - **A check is not in the type**, as it is not in the rule.
 *
 * **It is deliberately coarse: a position is `unknown` wherever the type cannot be certain what `redact` returns
 * there**, and never a different concrete type. Narrowing is the caller's job. A position is `unknown`:
 *
 * - **Below a union or an intersection with a loose object, a catchall, or an opaque option.** A key one option names
 *   may reach another's catchall at runtime, and an opaque option may hold anything, so every position under such a
 *   union is `unknown`. The union itself keeps its members' outer shape: `{ a: unknown } | Date`. A union of plain
 *   objects, arrays, records and tuples — a discriminated union included — stays precise.
 * - **At a key outside an object's shape**: a loose object's or a catchall's extra keys.
 * - **Past the depth the type reads.** It follows a schema {@link REDACT_TYPE_DEPTH} levels of structure deep, and
 *   searches an opaque node's insides as deep again; a recursive schema is searched once around its cycle. A position
 *   deeper than that, and an opaque node whose insides run deeper with no mark found, is `unknown`.
 * - **Where the schema's type names no kind**: one typed `z.ZodType<T>` — the annotation a recursive `z.lazy` needs —
 *   or `any`. A recursive schema written with a getter is inferred, and keeps its shape.
 */
export type RedactedOutput<S> = RedactedPosition<S, S, REDACT_TYPE_DEPTH>;

/**
 * A schema kind, read off its definition. Anything that is not a schema has a kind no branch below names: `never`
 * would match every branch, and a walk over a type that is not a schema would never end.
 */
type DefOf<S> = S extends { readonly _zod: { readonly def: infer D } } ? D : { readonly type: "not-a-schema" };

/** A schema's output, by its own `_zod`. Distributes over a union of schemas. */
type Out<S> = S extends { readonly _zod: { readonly output: infer O } } ? O : never;

/** The kinds a position is walked into. */
type Structural = "object" | "array" | "record" | "tuple";

/** The wrappers that are the same position as what they wrap. */
type Wrapper = "optional" | "nullable" | "default" | "prefault" | "readonly" | "catch" | "nonoptional";

/**
 * Every node at a position: `S` flattened through its wrappers, the options of a union, the sides of an intersection
 * and each lazy, to the structural and opaque nodes underneath. Distributes over a union of schemas.
 */
type Nodes<S, D extends number = REDACT_TYPE_DEPTH> = [D] extends [never]
  ? S
  : S extends unknown
    ? DefOf<S> extends { type: Wrapper; innerType: infer I }
      ? Nodes<I, Down<D>>
      : DefOf<S> extends { type: "union"; options: readonly (infer O)[] }
        ? Nodes<O, Down<D>>
        : DefOf<S> extends { type: "intersection"; left: infer L; right: infer R }
          ? Nodes<L, Down<D>> | Nodes<R, Down<D>>
          : DefOf<S> extends { type: "lazy"; getter: () => infer I }
            ? Nodes<I, Down<D>>
            : S
    : never;

/** Whether a node is one the rule walks into. */
type IsStructural<S> = DefOf<S> extends { type: Structural } ? true : false;

/** A Zod schema, as a definition slot holds one. */
type Schema = { readonly _zod: { readonly output: unknown; readonly def: unknown } };

/**
 * Whether a schema carries a mark anywhere inside it: on its output, or on any schema its definition holds — a pipe's
 * sides, a codec's wire side, an option, an element, a field, a lazy's target. What decides an opaque node.
 *
 A schema still unread at depth `D` is `"deep"`: the type cannot tell, and the position it decides is `unknown`. A
 * recursive schema runs the depth out the same way. There is no "seen this one" guard, on purpose: telling two deeply
 * nested schema types apart is where TypeScript gives up and calls them the same, which would stop the search on a
 * schema it never read.
 */
type HasMark<S, D extends number = REDACT_TYPE_DEPTH> = S extends Schema
  ? [D] extends [never]
    ? "deep"
    : true extends IsMarked<Out<S>>
      ? true
      : Verdict<
          {
            [K in keyof DefOf<S>]-?: K extends "checks" ? false : SlotHasMark<DefOf<S>[K], Down<D>>;
          }[keyof DefOf<S>]
        >
  : false;

/** One slot of a definition: a schema, a lazy's getter, a list of schemas, or an object's shape. */
type SlotHasMark<V, D extends number> = V extends Schema
  ? HasMark<V, D>
  : V extends () => infer R
    ? HasMark<R, D>
    : V extends readonly (infer E)[]
      ? HasMark<E, D>
      : V extends object
        ? { [K in keyof V]-?: V[K] extends Schema ? HasMark<V[K], D> : false }[keyof V]
        : false;

/** The opaque kinds that only ever hold a scalar, as `./classify` lists them. */
type Scalar =
  | "string"
  | "number"
  | "bigint"
  | "boolean"
  | "date"
  | "symbol"
  | "undefined"
  | "null"
  | "void"
  | "never"
  | "nan"
  | "literal"
  | "enum"
  | "template_literal";

/**
 * Whether a node is opaque and may hold whatever the rest of its position marks: a transform, an `unknown`, a custom,
 * or a coercion — `z.coerce.string()` is a string kind that takes an `unknown` input and runs `String()` over it. A
 * schema typed only as `z.ZodType<T>` names no kind, and is not one.
 */
type IsFree<N> =
  DefOf<N> extends { type: infer T }
    ? "object" extends T
      ? false
      : T extends Structural
        ? false
        : T extends Scalar
          ? unknown extends In<N>
            ? true
            : false
          : true
    : false;

/** A schema's input, by its own `_zod`. */
type In<S> = S extends { readonly _zod: { readonly input: infer I } } ? I : never;

/**
 * Whether a position is masked whole: a marked node, an opaque node with a mark inside, or an opaque node that may hold
 * anything where something else at the position carries a mark. `"deep"` when no mark was found but a search ran out
 * of depth, so the type cannot tell.
 */
type MaskedWhole<S> = Verdict<
  | IsMarked<Out<S>>
  | IsMarked<Out<Nodes<S>>>
  | OpaqueMarked<Nodes<S>>
  | (true extends FreeAt<Nodes<S>> ? CarriesAt<Nodes<S>> : false)
>;

/** Whether a union of string literals has more than one member. */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * Whether `S` reaches its position through a union or an intersection: the position may hold more than one node.
 * Read through the wrappers and each lazy, and taken as `true` where the depth runs out.
 */
type HasJoin<S, D extends number = REDACT_TYPE_DEPTH> = [D] extends [never]
  ? true
  : S extends unknown
    ? DefOf<S> extends { type: "union" | "intersection" }
      ? true
      : DefOf<S> extends { type: Wrapper; innerType: infer I }
        ? HasJoin<I, Down<D>>
        : DefOf<S> extends { type: "lazy"; getter: () => infer I }
          ? HasJoin<I, Down<D>>
          : false
    : never;

/**
 * Whether a node lets a key or an element reach a schema the type does not follow: a loose object or one with a
 * catchall, whose output has a string index, or any opaque node.
 */
type Open<N> = N extends unknown
  ? IsStructural<N> extends true
    ? DefOf<N> extends { type: "object" }
      ? string extends keyof Out<N>
        ? true
        : false
      : false
    : true
  : never;

/**
 * Whether the positions below a position are `unknown`: it may be reached by more than one node — `M`, a union's
 * options or an intersection's sides here or above it — and one of the nodes here is {@link Open}.
 */
type Coarse<N, M extends boolean> = M extends true ? (true extends Open<N> ? true : false) : false;

/** Whether a node's schema type names no single kind: one typed `z.ZodType<T>`, whose definition could be any. */
type Unnamed<N> = N extends unknown
  ? DefOf<N> extends { type: infer T }
    ? true extends IsUnion<T>
      ? true
      : string extends T
        ? true
        : false
    : true
  : never;

/** Whether an opaque node among `N` carries a mark. */
type OpaqueMarked<N> = N extends unknown ? (IsStructural<N> extends true ? false : HasMark<N>) : never;

/** Whether an opaque node among `N` may hold anything. */
type FreeAt<N> = N extends unknown ? IsFree<N> : never;

/** Whether any node among `N` carries a mark. */
type CarriesAt<N> = N extends unknown ? HasMark<N> : never;

/**
 * One member's schema `S` at a position, against `C`, every schema that reaches the position. `C` decides whether the
 * position is masked, and what is at each position below it; `S` decides the shape this member keeps.
 */
type RedactedPosition<S, C, D extends number, M extends boolean = false> = [S] extends [never]
  ? never
  : IsAny<Out<S>> extends true
    ? unknown
    : [D] extends [never]
      ? unknown
      : MaskedWhole<C> extends true
        ? string | Extract<Out<S>, null | undefined>
        : MaskedWhole<C> extends "deep"
          ? unknown
          : true extends Unnamed<Nodes<C>>
            ? unknown
            : Joined<S, C, D, M extends true ? true : true extends HasJoin<C> ? true : false>;

/** {@link Shaped}, with `M` settled: once a position may hold more than one node, every position below it may too. */
type Joined<S, C, D extends number, M extends boolean> = Shaped<
  S,
  Nodes<C>,
  Coarse<Nodes<C>, M> extends true ? never : D,
  M
>;

/**
 * One schema at a position that is walked into, against `C`, every node at the position: a wrapper keeps what it
 * adds, a union and an intersection keep their form, and a structural node maps by every node's schemas. `D` is
 * `never` below a {@link Coarse} position, so every position under it is `unknown`. An opaque node with no mark keeps
 * its output type, which is exactly what `redact` hands back.
 */
type Shaped<S, C, D extends number, M extends boolean> = S extends unknown
  ? DefOf<S> extends { type: "optional"; innerType: infer I }
    ? Shaped<I, C, D, M> | undefined
    : DefOf<S> extends { type: "nullable"; innerType: infer I }
      ? Shaped<I, C, D, M> | null
      : DefOf<S> extends { type: "default" | "prefault" | "nonoptional"; innerType: infer I }
        ? Exclude<Shaped<I, C, D, M>, undefined>
        : DefOf<S> extends { type: "catch"; innerType: infer I }
          ? Shaped<I, C, D, M>
          : DefOf<S> extends { type: "readonly"; innerType: infer I }
            ? Readonly<Shaped<I, C, D, M>>
            : DefOf<S> extends { type: "lazy"; getter: () => infer I }
              ? Shaped<I, C, D, M>
              : DefOf<S> extends { type: "union"; options: readonly (infer O)[] }
                ? Shaped<O, C, D, M>
                : DefOf<S> extends { type: "intersection"; left: infer L; right: infer R }
                  ? Shaped<L, C, D, M> & Shaped<R, C, D, M>
                  : DefOf<S> extends { type: "object"; shape: infer Shape }
                    ? {
                        [K in keyof Out<S>]: K extends keyof Shape
                          ? RedactedPosition<Shape[K], FieldSchemas<C, K>, Down<D>, M>
                          : unknown;
                      }
                    : DefOf<S> extends { type: "record"; valueType: infer V }
                      ? {
                          [K in keyof Out<S> as MaskedWhole<KeySchemas<C>> extends false
                            ? K
                            : string]: RedactedPosition<V, FieldSchemas<C, K>, Down<D>, M>;
                        }
                      : DefOf<S> extends { type: "array"; element: infer E }
                        ? RedactedPosition<E, ElementSchemas<C, number>, Down<D>, M>[]
                        : DefOf<S> extends {
                              type: "tuple";
                              items: infer Items extends readonly unknown[];
                              rest: infer R;
                            }
                          ? ShapedTuple<Items, R, C, D, M>
                          : Out<S>
  : never;

/** A tuple's items position by position, then its rest. Mapped over a type parameter, so it stays a tuple. */
type ShapedTuple<Items extends readonly unknown[], R, C, D extends number, M extends boolean> = [R] extends [null]
  ? TupleItems<Items, C, D, M>
  : [...TupleItems<Items, C, D, M>, ...RedactedPosition<R, ElementSchemas<C, number>, Down<D>, M>[]];

type TupleItems<Items extends readonly unknown[], C, D extends number, M extends boolean> = {
  -readonly [K in keyof Items]: RedactedPosition<Items[K], ElementSchemas<C, K>, Down<D>, M>;
};

/** The schemas at object key `K`: each object's field there, and each record's value. */
type FieldSchemas<C, K> = C extends unknown
  ? DefOf<C> extends { type: "object"; shape: infer Shape }
    ? K extends keyof Shape
      ? Shape[K]
      : never
    : DefOf<C> extends { type: "record"; valueType: infer V }
      ? V
      : never
  : never;

/** The schemas a record's keys are parsed by. */
type KeySchemas<C> = C extends unknown ? (DefOf<C> extends { type: "record"; keyType: infer K } ? K : never) : never;

/**
 * The schemas at element `K`: each array's element, and each tuple's item there. `number` is any element of an array,
 * which may sit at any tuple position or past them all, so it takes every item and the rest.
 */
type ElementSchemas<C, K> = C extends unknown
  ? DefOf<C> extends { type: "array"; element: infer E }
    ? E
    : DefOf<C> extends { type: "tuple"; items: infer Items extends readonly unknown[]; rest: infer R }
      ? K extends number
        ? Items[number] | Exclude<R, null>
        : K extends keyof Items
          ? Items[K]
          : never
      : never
  : never;
