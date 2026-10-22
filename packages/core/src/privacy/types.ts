// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import type { SQLiteBoolean, SQLiteDate, SqliteJsonSchema } from "../data/codecs";
import type { MAX_RECURSION_DEPTH, ValueKind } from "./classify";

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
 * What `redact(schema, value)` returns, named by the schema: the type a caller names for a value it already redacted,
 * `Redacted<typeof User>`. It is {@link RedactedOutput}, and it takes the schema rather than the value's type on
 * purpose: a value's type cannot tell a plain object from the output of a transform, which `redact` may mask whole.
 */
export type Redacted<S extends z.ZodType> = RedactedOutput<S>;

/**
 * **What `redact(schema, value)` returns, read off the schema: the redaction contract (`./redact`) at the type level.**
 *
 * - **A marked position is a `string`**, beside the `null` or `undefined` its wrappers add: a marked node, or a
 *   position a mark reaches through no union option. A mark reached through an option applies where the value has
 *   that option's shape, so an option of another shape beside it keeps its own type: `z.union([pii(z.string()),
 *   z.array(z.string())])` is `string | string[]`.
 * - **Every structural kind keeps its shape**: an object maps its fields, an array and a tuple their elements, a
 *   record and a map their values, a set its elements, and a marked key becomes `string`. Each wrapper keeps what it
 *   adds. A union is a union of its members and an intersection intersects its sides, each with every option's and
 *   every side's marks at each position: an array beside a tuple is typed index by index where the tuple names one,
 *   and a record or an open object beside an object types each key the object names. The kit's three codecs are the
 *   schema they decode to, and a JSON column is known by the type `sqliteJson` returns, never by its shape.
 * - **An opaque node is its own output**, or `unknown` where a mark sits anywhere beneath it or may, because `redact`
 *   masks it whole there. The search beneath it reads every schema once, to the one recursion limit, so an unmarked
 *   schema of any depth keeps its output. A recursion beneath it is `unknown` however it is written, as a type cannot
 *   tell one defined once from one built anew, which reaches the limit and is masked; so is a schema annotated
 *   `z.ZodType<T>` beneath it. That is the one place the type says `unknown`, with two more a type cannot see past: a
 *   schema annotated `z.ZodType<T>`, as a self-referencing `z.lazy` must be, names no kind; and `any`.
 * - **A position nested deeper than {@link REDACT_RECURSION_DEPTH} levels is `unknown`**, as `redact` masks it whole
 *   from the same depth: every object, array, tuple, record, map and set above it counts one.
 */
export type RedactedOutput<S> = At<S, S, []>;

/**
 * The one recursion limit, in levels of nesting: the type of `MAX_RECURSION_DEPTH`, the constant `redact` stops at. A
 * position nested deeper than this is `unknown`, as `redact` masks it whole there.
 */
export type REDACT_RECURSION_DEPTH = typeof MAX_RECURSION_DEPTH;

/** How deep a position is: one element per level of nesting above it, or `"past"` beyond the limit. */
type Depth = readonly unknown[] | "past";

/** One level of nesting below `D`. */
type Deeper<D extends Depth> = D extends readonly unknown[]
  ? D["length"] extends REDACT_RECURSION_DEPTH
    ? "past"
    : [...D, 0]
  : "past";

/** A schema kind, read off its definition. Anything that is not a schema has a kind no branch below names. */
type DefOf<S> = S extends { readonly _zod: { readonly def: infer D } } ? D : { readonly type: "not-a-schema" };

/** A schema's output, by its own `_zod`. Distributes over a union of schemas. */
type Out<S> = S extends { readonly _zod: { readonly output: infer O } } ? O : never;

/** A Zod schema, as a definition slot holds one. */
type Schema = { readonly _zod: { readonly output: unknown; readonly def: unknown } };

/** The wrappers that are the same position as what they wrap. */
type Wrapper = "optional" | "nullable" | "default" | "prefault" | "readonly" | "catch" | "nonoptional";

/** The kinds a value is walked into. */
type Structural = "object" | "array" | "tuple" | "record" | "map" | "set";

/**
 * The schema one of the kit's three codecs decodes to, or `never` for any other node. A JSON column is known by the type
 * `sqliteJson` names, never by its shape: an adopter's codec built the same way is opaque, as it is to `redact`.
 */
type KitCodec<S> = S extends typeof SQLiteDate | typeof SQLiteBoolean
  ? DefOf<S> extends { out: infer O }
    ? O
    : never
  : SqliteJsonSchema<S>;

/**
 * Whether a schema is a marked node: every value its output holds, `null` and `undefined` aside, carries a privacy
 * brand. A union with one marked option among others is not one; it is read option by option.
 */
type IsMarkedNode<S> = [Exclude<Out<S>, null | undefined>] extends [never]
  ? false
  : false extends IsMarked<Exclude<Out<S>, null | undefined>>
    ? false
    : true;

/** The shape each kind of schema produces, as `kindsOf` reads it at runtime. */
interface SchemaKinds {
  string: "string";
  template_literal: "string";
  number: "number";
  nan: "number";
  bigint: "bigint";
  boolean: "boolean";
  symbol: "symbol";
  function: "function";
  date: "date";
  object: "object";
  record: "object";
  array: "array";
  tuple: "array";
  map: "map";
  set: "set";
}

/** The shape of a value of type `T`, as `kindOfValue` reads it at runtime. Distributes; every shape for `unknown`. */
type OutKind<T> = T extends null | undefined
  ? never
  : T extends string
    ? "string"
    : T extends number
      ? "number"
      : T extends bigint
        ? "bigint"
        : T extends boolean
          ? "boolean"
          : T extends symbol
            ? "symbol"
            : T extends Date
              ? "date"
              : T extends readonly unknown[]
                ? "array"
                : T extends ReadonlyMap<unknown, unknown>
                  ? "map"
                  : T extends ReadonlySet<unknown>
                    ? "set"
                    : T extends (...args: never[]) => unknown
                      ? "function"
                      : T extends object
                        ? "object"
                        : ValueKind;

/**
 * The shapes a schema's output can have, read the way `kindsOf` reads them: through wrappers, the options of a union,
 * the sides of an intersection, a lazy and the kit's codecs. Every shape for an opaque node. Distributes.
 */
type KindOf<S, D extends number = REDACT_TYPE_DEPTH> = [D] extends [never]
  ? ValueKind
  : S extends unknown
    ? DefOf<S> extends { type: Wrapper; innerType: infer I }
      ? KindOf<I, Down<D>>
      : DefOf<S> extends { type: "union"; options: readonly (infer O)[] }
        ? KindOf<O, Down<D>>
        : DefOf<S> extends { type: "intersection"; left: infer L; right: infer R }
          ? Extract<KindOf<L, Down<D>>, KindOf<R, Down<D>>>
          : DefOf<S> extends { type: "lazy"; getter: () => infer I }
            ? KindOf<I, Down<D>>
            : DefOf<S> extends { type: infer T extends keyof SchemaKinds }
              ? SchemaKinds[T]
              : DefOf<S> extends { type: "literal" | "enum" }
                ? OutKind<Out<S>>
                : DefOf<S> extends { type: "null" | "undefined" | "void" | "never" }
                  ? never
                  : [KitCodec<S>] extends [never]
                    ? ValueKind
                    : KitCodec<S> extends infer C
                      ? KindOf<C, Down<D>>
                      : never
    : never;

/**
 * The shapes of value a position masks: every shape for a mark reached through no union option, and, for one reached
 * through options, the shapes every option on the way has. `never` where nothing here is marked. Distributes.
 */
type MaskedKinds<S, G = ValueKind, D extends number = REDACT_TYPE_DEPTH> = [D] extends [never]
  ? G
  : S extends unknown
    ? IsMarkedNode<S> extends true
      ? G
      : DefOf<S> extends { type: Wrapper; innerType: infer I }
        ? MaskedKinds<I, G, Down<D>>
        : DefOf<S> extends { type: "union"; options: readonly (infer O)[] }
          ? Gated<O, G, Down<D>>
          : DefOf<S> extends { type: "intersection"; left: infer L; right: infer R }
            ? MaskedKinds<L, G, Down<D>> | MaskedKinds<R, G, Down<D>>
            : DefOf<S> extends { type: "lazy"; getter: () => infer I }
              ? MaskedKinds<I, G, Down<D>>
              : [KitCodec<S>] extends [never]
                ? never
                : MaskedKinds<KitCodec<S>, G, Down<D>>
    : never;

/** Each union option's marks, narrowed to the shapes that option has. Distributes over the options. */
type Gated<O, G, D extends number> = O extends unknown ? MaskedKinds<O, Extract<G, KindOf<O>>, D> : never;

/** A structural node's shape, where a mark masks it whole. */
type StructuralKind<S> =
  DefOf<S> extends { type: "object" | "record" }
    ? "object"
    : DefOf<S> extends { type: "array" | "tuple" }
      ? "array"
      : DefOf<S> extends { type: "map" }
        ? "map"
        : DefOf<S> extends { type: "set" }
          ? "set"
          : never;

/** An output with each value of a masked shape `M` masked to a `string`. Distributes; `unknown` stays `unknown`. */
type MaskOut<T, M> = unknown extends T
  ? T
  : T extends null | undefined
    ? T
    : [OutKind<T>] extends [never]
      ? T
      : OutKind<T> extends M
        ? string
        : T;

/**
 * Every node at a position: `S` flattened through its wrappers, the options of a union, the sides of an intersection,
 * each lazy and the kit's codecs, stopping at a marked node. Distributes over a union of schemas.
 */
type Nodes<S, D extends number = REDACT_TYPE_DEPTH> = [D] extends [never]
  ? S
  : S extends unknown
    ? IsMarkedNode<S> extends true
      ? S
      : DefOf<S> extends { type: Wrapper; innerType: infer I }
        ? Nodes<I, Down<D>>
        : DefOf<S> extends { type: "union"; options: readonly (infer O)[] }
          ? Nodes<O, Down<D>>
          : DefOf<S> extends { type: "intersection"; left: infer L; right: infer R }
            ? Nodes<L, Down<D>> | Nodes<R, Down<D>>
            : DefOf<S> extends { type: "lazy"; getter: () => infer I }
              ? Nodes<I, Down<D>>
              : [KitCodec<S>] extends [never]
                ? S
                : Nodes<KitCodec<S>, Down<D>>
    : never;

/** How many levels of wrapper, choice and lazy {@link Nodes} flattens. */
export type REDACT_TYPE_DEPTH = 16;

/** Whether a node is one the walk goes into. */
type IsStructural<S> = DefOf<S> extends { type: Structural } ? true : false;

/** A search's answer: `true` when a mark was found, `"deep"` when none was but it ran out of depth. */
type Verdict<R> = true extends R ? true : "deep" extends R ? "deep" : false;

/**
 * Whether a schema carries a mark anywhere beneath it: `true`, `false`, or `"deep"` where the search ran past the one
 * recursion limit, or may. It reads level by level, every schema once; as the runtime search does, a level is one more
 * object, array, tuple, record, map, set or lazy. It is `"deep"` wherever it meets a recursion, a getter or a lazy
 * that comes round to a schema above it: a type cannot tell one defined once, which the runtime reads to its end, from
 * one built anew each read, which reaches the limit and is masked whole. So is a schema annotated `z.ZodType<T>`,
 * which names no kind the search could read inside.
 */
type HasMark<S> = SearchLevel<S, never, never, []>;

/**
 * One round of the search. `Cur` is still to read at depth `L`, `Next` waits for the level below, and `Seen` has been
 * read. A schema is seen when it and one already read are each assignable to the other.
 */
type SearchLevel<Cur, Next, Seen, L extends readonly unknown[]> = [Cur] extends [never]
  ? [Next] extends [never]
    ? false
    : SearchLevel<Next, never, Seen, [...L, 0]>
  : true extends Recurs<Cur, Seen>
    ? "deep"
    : Unseen<Cur, Seen> extends infer New
      ? [New] extends [never]
        ? SearchLevel<never, Next, Seen, L>
        : true extends AnyBranded<New>
          ? true
          : true extends Unnamed<New>
            ? "deep"
            : [Nested<New>] extends [never]
              ? SearchLevel<Children<New>, Next, Seen | New, L>
              : L["length"] extends REDACT_RECURSION_DEPTH
                ? "deep"
                : SearchLevel<Children<Flat<New>>, Next | Children<Nested<New>>, Seen | New, L>
      : never;

/**
 * Whether a schema met again is a recursion: one among `Cur` already read, a level counted at it, that reaches itself.
 * A schema used twice at two depths is met again too, and reaches no copy of itself. Distributes.
 */
type Recurs<Cur, Seen> =
  Nested<Cur> extends infer R
    ? R extends unknown
      ? true extends IsSeen<R, Seen>
        ? Reaches<Children<R>, R, never>
        : false
      : never
    : never;

/** Whether `T` is among the schemas beneath `Cur`, each read once. */
type Reaches<Cur, T, Seen> = [Cur] extends [never]
  ? false
  : true extends IsSeen<T, Cur>
    ? true
    : Reaches<Children<Unseen<Cur, Seen>>, T, Seen | Cur>;

/** The schemas among `N` not yet read. Distributes. */
type Unseen<N, Seen> = N extends unknown ? (true extends IsSeen<N, Seen> ? never : N) : never;

/** Whether `N` is one of `Seen`: each assignable to the other. */
type IsSeen<N, Seen> = Seen extends unknown
  ? [N] extends [Seen]
    ? [Seen] extends [N]
      ? true
      : false
    : false
  : never;

/** Whether any schema among `N` has a privacy brand on its output. Distributes. */
type AnyBranded<N> = N extends Schema ? IsMarked<Out<N>> : false;

/** The schemas among `N` a level of nesting is counted at. Distributes. */
type Nested<N> = N extends unknown ? (DefOf<N> extends { type: Structural | "lazy" } ? N : never) : never;

/** The schemas among `N` read at the level they sit at. Distributes. */
type Flat<N> = N extends unknown ? (DefOf<N> extends { type: Structural | "lazy" } ? never : N) : never;

/**
 * Every schema a definition holds: a schema, a lazy's getter, a list of schemas, or an object's shape. An object's
 * definition names its catchall only as a schema of any kind, so the catchall is read from its config. Distributes.
 */
type Children<N> = N extends Schema
  ?
      | { [K in keyof DefOf<N>]-?: K extends "checks" | "catchall" ? never : SlotSchemas<DefOf<N>[K]> }[keyof DefOf<N>]
      | OpenCatchall<N>
  : never;

/** The schemas one slot of a definition holds. */
type SlotSchemas<V> = V extends Schema
  ? V
  : V extends () => infer R
    ? Extract<R, Schema>
    : V extends readonly (infer E)[]
      ? Extract<E, Schema>
      : V extends object
        ? { [K in keyof V]-?: V[K] extends Schema ? V[K] : never }[keyof V]
        : never;

/** Whether any node among `N` is marked. Distributes. */
type AnyMarked<N> = N extends unknown ? IsMarkedNode<N> : never;

/** Whether an opaque node among `N` carries a mark beneath it, or may. Distributes. */
type AnyOpaqueMarked<N> = N extends unknown
  ? IsMarkedNode<N> extends true
    ? false
    : IsStructural<N> extends true
      ? false
      : HasMark<N>
  : never;

/** Whether a node's schema type names no single kind: one typed `z.ZodType<T>`, whose definition could be any. */
type Unnamed<N> = N extends unknown
  ? DefOf<N> extends { type: infer T }
    ? string extends T
      ? true
      : IsUnion<T>
    : true
  : never;

/** Whether a union of string literals has more than one member. */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * One member's schema `S` at a position `D` levels deep, against `C`, every schema that reaches it. `C` decides whether
 * the position is masked, and what is at each position below it; `S` decides the shape this member keeps.
 */
type At<S, C, D extends Depth> = [S] extends [never]
  ? never
  : [D] extends ["past"]
    ? unknown
    : IsAny<Out<S>> extends true
      ? unknown
      : Verdict<AnyOpaqueMarked<Nodes<C>>> extends false
        ? Masked<S, C, D, MaskedKinds<C>>
        : unknown;

/**
 * A position whose values of shape `M` are masked: a `string` where every shape is, and otherwise each member keeps
 * its shape, with its values of a masked shape a `string`.
 */
type Masked<S, C, D extends Depth, M> = [ValueKind] extends [M]
  ? string | Extract<Out<S>, null | undefined>
  : true extends Unnamed<Nodes<C>>
    ? unknown
    : Shaped<S, Nodes<C>, D, M>;

/** A structural result keeps a brand that is not a privacy class, as the copy is the same kind of value. */
type Rebrand<S, X> =
  Out<S> extends { readonly [z.core.$brand]: infer B } ? KeptBrand<X, Exclude<keyof B, `privacy:${string}`>> : X;

/** `X` with the brands `K`, or `X` itself where there are none. */
type KeptBrand<X, K> = [K] extends [never] ? X : X & z.core.$brand<K & (string | number | symbol)>;

/** Keys renamed to `string` where a record at the position masks its keys. */
type KeyName<K, N> = K extends typeof z.core.$brand ? never : true extends AnyMarked<Nodes<RecordKeys<N>>> ? string : K;

/**
 * One schema at a position that is walked into, against `N`, every node at the position, with the values of a shape
 * in `M` masked: a marked node is a `string`, a wrapper keeps what it adds, a union and an intersection keep their
 * form, and a structural node maps by every node's schemas, or is a `string` where its shape is masked. Any other
 * node, unmarked and with nothing marked beneath it, keeps its output type, which is what `redact` hands back.
 */
type Shaped<S, N, D extends Depth, M> = S extends unknown
  ? IsMarkedNode<S> extends true
    ? string | Extract<Out<S>, null | undefined>
    : StructuralKind<S> extends infer K
      ? [K] extends [never]
        ? Rebrand<S, ShapedNode<S, N, D, M>>
        : K extends M
          ? string
          : Rebrand<S, ShapedNode<S, N, D, M>>
      : never
  : never;

/** {@link Shaped}, before a brand that is not a privacy class is put back. */
type ShapedNode<S, N, D extends Depth, M> = S extends unknown
  ? DefOf<S> extends { type: "optional"; innerType: infer I }
    ? Shaped<I, N, D, M> | undefined
    : DefOf<S> extends { type: "nullable"; innerType: infer I }
      ? Shaped<I, N, D, M> | null
      : DefOf<S> extends { type: "default" | "prefault" | "nonoptional"; innerType: infer I }
        ? Exclude<Shaped<I, N, D, M>, undefined>
        : DefOf<S> extends { type: "catch"; innerType: infer I }
          ? Shaped<I, N, D, M>
          : DefOf<S> extends { type: "readonly"; innerType: infer I }
            ? z.core.util.MakeReadonly<Shaped<I, N, D, M>>
            : DefOf<S> extends { type: "lazy"; getter: () => infer I }
              ? Shaped<I, N, D, M>
              : DefOf<S> extends { type: "union"; options: readonly (infer O)[] }
                ? Shaped<O, N, D, M>
                : DefOf<S> extends { type: "intersection"; left: infer L; right: infer R }
                  ? Shaped<L, N, D, M> & Shaped<R, N, D, M>
                  : DefOf<S> extends { type: Structural }
                    ? Walked<S, N, D>
                    : [KitCodec<S>] extends [never]
                      ? MaskOut<Out<S>, M>
                      : Shaped<KitCodec<S>, N, D, M>
  : never;

/** A structural node, mapped by every node's schemas at the position. */
type Walked<S, N, D extends Depth, E extends Depth = Deeper<D>> =
  DefOf<S> extends { type: "object"; shape: infer Shape }
    ? WithNamed<
        {
          [K in keyof Out<S> as KeyName<K, N>]: K extends keyof Shape
            ? At<Shape[K], Fields<N, K>, E>
            : At<OpenCatchall<S>, Catchalls<N>, E> | NamedAt<OpenCatchall<S>, N, Exclude<NamedKeys<N>, keyof Shape>, E>;
        },
        [OpenCatchall<S>] extends [never] ? never : OpenCatchall<S>,
        N,
        Exclude<NamedKeys<N>, keyof Shape>,
        E
      >
    : DefOf<S> extends { type: "record"; valueType: infer V }
      ? string extends keyof Out<S>
        ? WithNamed<
            { [K in keyof Out<S> as KeyName<K, N>]: At<V, Fields<N, K>, E> | NamedAt<V, N, NamedKeys<N>, E> },
            V,
            N,
            NamedKeys<N>,
            E
          >
        : { [K in keyof Out<S> as KeyName<K, N>]: At<V, Fields<N, K>, E> }
      : DefOf<S> extends { type: "array"; element: infer El }
        ? Beyond<El, N, [], E>
        : DefOf<S> extends {
              type: "tuple";
              items: infer Items extends readonly z.core.SomeType[];
              rest: infer R extends z.core.SomeType | null;
            }
          ? // The tuple's own items, rebuilt from them so a brand on it does not turn it into an array, then its rest.
            z.output<z.ZodTuple<Items, null>> extends infer O extends readonly unknown[]
            ? [
                ...{ -readonly [K in keyof O]: K extends keyof Items ? At<Items[K], Elements<N, K>, E> : never },
                ...(R extends z.core.SomeType ? Beyond<R, N, [...Items], E> : []),
              ]
            : never
          : DefOf<S> extends { type: "map"; keyType: infer K; valueType: infer V }
            ? Map<At<K, MapKeys<N>, E>, At<V, MapValues<N>, E>>
            : DefOf<S> extends { type: "set"; valueType: infer V }
              ? Set<At<V, SetElements<N>, E>>
              : never;

/**
 * The keys the objects at a position name. A record or an open object beside them takes each one where the value has
 * it, at the position every schema there gives that key: `{ a: pii(…) }` beside a record masks the record's `a`.
 */
type NamedKeys<N> = N extends unknown
  ? DefOf<N> extends { type: "object"; shape: infer Shape }
    ? Extract<keyof Shape, string>
    : never
  : never;

/** What a key in `Keys` holds, against every schema there, for a value parsed by `V`. Distributes over the keys. */
type NamedAt<V, N, Keys, D extends Depth> = Keys extends unknown ? At<V, Fields<N, Keys>, D> : never;

/** `Mapped`, with each key in `Keys` an optional field of its own where `V` lets a key no shape names through. */
type WithNamed<Mapped, V, N, Keys extends PropertyKey, D extends Depth> = [V] extends [never]
  ? Mapped
  : [Keys] extends [never]
    ? Mapped
    : Mapped & { [K in Keys as KeyName<K, N>]?: At<V, Fields<N, K>, D> };

/**
 * An array's element, or a tuple's rest, from index `I["length"]` on: optional and one by one while a tuple beside it
 * names the index, so each takes the items there, then any number past every tuple's items.
 */
type Beyond<E, N, I extends unknown[], D extends Depth> =
  true extends NamesIndex<N, `${I["length"]}`>
    ? [At<E, Elements<N, `${I["length"]}`>, D>?, ...Beyond<E, N, [...I, unknown], D>]
    : At<E, Past<N>, D>[];

/** Whether a tuple at the position names index `K`. */
type NamesIndex<N, K extends string> = N extends unknown
  ? DefOf<N> extends { type: "tuple"; items: infer Items extends readonly unknown[] }
    ? K extends keyof Items
      ? true
      : false
    : false
  : never;

/** The schemas at an index past every tuple's items: each array's element and each tuple's rest. */
type Past<N> = N extends unknown
  ? DefOf<N> extends { type: "array"; element: infer E }
    ? E
    : DefOf<N> extends { type: "tuple"; rest: infer R }
      ? Exclude<R, null>
      : never
  : never;

/** The schemas at object key `K`: each object's field there or its catchall, and each record's value. */
type Fields<N, K> = N extends unknown
  ? DefOf<N> extends { type: "object"; shape: infer Shape }
    ? K extends keyof Shape
      ? Shape[K]
      : OpenCatchall<N>
    : DefOf<N> extends { type: "record"; valueType: infer V }
      ? V
      : never
  : never;

/**
 * An object's catchall when it lets an extra key through, or `never`. Zod's object type keeps the catchall only in
 * its config, `$catchall<T>`, and TypeScript reads `T` back out of that alias. A loose object's is `unknown`'s.
 */
type OpenCatchall<N> = N extends { readonly _zod: { readonly config: infer Config } }
  ? Config extends { readonly out: infer O }
    ? string extends keyof O
      ? Config extends z.core.$catchall<infer T>
        ? T
        : never
      : never
    : never
  : never;

/** The schemas at a key no object names. */
type Catchalls<N> = N extends unknown
  ? DefOf<N> extends { type: "object" }
    ? OpenCatchall<N>
    : DefOf<N> extends { type: "record"; valueType: infer V }
      ? V
      : never
  : never;

/** The schemas a record's keys are parsed by. */
type RecordKeys<N> = N extends unknown ? (DefOf<N> extends { type: "record"; keyType: infer K } ? K : never) : never;

/** The schemas of a map's keys, a map's values and a set's elements. */
type MapKeys<N> = N extends unknown ? (DefOf<N> extends { type: "map"; keyType: infer K } ? K : never) : never;
type MapValues<N> = N extends unknown ? (DefOf<N> extends { type: "map"; valueType: infer V } ? V : never) : never;
type SetElements<N> = N extends unknown ? (DefOf<N> extends { type: "set"; valueType: infer V } ? V : never) : never;

/** The schemas at element `K`, an index: each array's element, and each tuple's item there or its rest. */
type Elements<N, K> = N extends unknown
  ? DefOf<N> extends { type: "array"; element: infer E }
    ? E
    : DefOf<N> extends { type: "tuple"; items: infer Items extends readonly unknown[]; rest: infer R }
      ? K extends keyof Items
        ? Items[K]
        : Exclude<R, null>
      : never
  : never;
