// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import type { SQLiteBoolean, SQLiteDate } from "../data/codecs";

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
 * - **A marked position is a `string`**, beside the `null` or `undefined` its wrappers add: a marked node, or any
 *   option or side of one that is.
 * - **Every structural kind keeps its shape**: an object maps its fields, an array and a tuple their elements, a
 *   record and a map their values, a set its elements, and a marked key becomes `string`. Each wrapper keeps what it
 *   adds. A union is a union of its members and an intersection intersects its sides, each with every option's and
 *   every side's marks at each position. The kit's three codecs are the schema they decode to.
 * - **An opaque node is its own output**, or `unknown` where a mark sits anywhere beneath it, because `redact` masks
 *   it whole there. That is the one place the type says `unknown`, with two more a type cannot see past: a schema
 *   annotated `z.ZodType<T>`, as a self-referencing `z.lazy` must be, names no kind; and `any` is `unknown`.
 */
export type RedactedOutput<S> = At<S, S>;

/** How deep a search for a mark beneath an opaque node reads. Past it, the type cannot tell, and says `unknown`. */
type SEARCH_DEPTH = 12;

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

/** The schema one of the kit's three codecs decodes to, or `never` for any other node. */
type KitCodec<S> = S extends typeof SQLiteDate | typeof SQLiteBoolean
  ? DefOf<S> extends { out: infer O }
    ? O
    : never
  : S extends z.ZodCodec<z.ZodUnion<readonly [z.ZodString, infer T extends z.ZodType]>, infer U extends z.ZodType>
    ? [T] extends [U]
      ? [U] extends [T]
        ? U
        : never
      : never
    : never;

/** Whether a schema's own output carries a privacy brand: a marked node, read through its wrappers. */
type IsMarkedNode<S> = true extends IsMarked<Out<S>> ? true : false;

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

/** Whether a schema carries a mark anywhere beneath it: on its output, or on any schema its definition holds. */
type HasMark<S, D extends number = SEARCH_DEPTH> = S extends Schema
  ? [D] extends [never]
    ? "deep"
    : true extends IsMarked<Out<S>>
      ? true
      : Verdict<
          { [K in keyof DefOf<S>]-?: K extends "checks" ? false : SlotHasMark<DefOf<S>[K], Down<D>> }[keyof DefOf<S>]
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
 * One member's schema `S` at a position, against `C`, every schema that reaches it. `C` decides whether the position
 * is masked, and what is at each position below it; `S` decides the shape this member keeps.
 */
type At<S, C> = [S] extends [never]
  ? never
  : IsAny<Out<S>> extends true
    ? unknown
    : Verdict<AnyOpaqueMarked<Nodes<C>>> extends false
      ? true extends AnyMarked<Nodes<C>>
        ? string | Extract<Out<S>, null | undefined>
        : true extends Unnamed<Nodes<C>>
          ? unknown
          : Shaped<S, Nodes<C>>
      : unknown;

/** A structural result keeps a brand that is not a privacy class, as the copy is the same kind of value. */
type Rebrand<S, X> = Out<S> extends { readonly [z.core.$brand]: infer B } ? X & { readonly [z.core.$brand]: B } : X;

/** Keys renamed to `string` where a record at the position masks its keys. */
type KeyName<K, N> = K extends typeof z.core.$brand ? never : true extends AnyMarked<Nodes<RecordKeys<N>>> ? string : K;

/**
 * One schema at a position that is walked into, against `N`, every node at the position: a wrapper keeps what it
 * adds, a union and an intersection keep their form, and a structural node maps by every node's schemas. Any other
 * node, unmarked and with nothing marked beneath it, keeps its output type, which is what `redact` hands back.
 */
type Shaped<S, N> = S extends unknown ? Rebrand<S, ShapedNode<S, N>> : never;

/** {@link Shaped}, before a brand that is not a privacy class is put back. */
type ShapedNode<S, N> = S extends unknown
  ? DefOf<S> extends { type: "optional"; innerType: infer I }
    ? Shaped<I, N> | undefined
    : DefOf<S> extends { type: "nullable"; innerType: infer I }
      ? Shaped<I, N> | null
      : DefOf<S> extends { type: "default" | "prefault" | "nonoptional"; innerType: infer I }
        ? Exclude<Shaped<I, N>, undefined>
        : DefOf<S> extends { type: "catch"; innerType: infer I }
          ? Shaped<I, N>
          : DefOf<S> extends { type: "readonly"; innerType: infer I }
            ? z.core.util.MakeReadonly<Shaped<I, N>>
            : DefOf<S> extends { type: "lazy"; getter: () => infer I }
              ? Shaped<I, N>
              : DefOf<S> extends { type: "union"; options: readonly (infer O)[] }
                ? Shaped<O, N>
                : DefOf<S> extends { type: "intersection"; left: infer L; right: infer R }
                  ? Shaped<L, N> & Shaped<R, N>
                  : DefOf<S> extends { type: Structural }
                    ? Walked<S, N>
                    : [KitCodec<S>] extends [never]
                      ? Out<S>
                      : Shaped<KitCodec<S>, N>
  : never;

/** A structural node, mapped by every node's schemas at the position. */
type Walked<S, N> =
  DefOf<S> extends { type: "object"; shape: infer Shape }
    ? {
        [K in keyof Out<S> as KeyName<K, N>]: K extends keyof Shape
          ? At<Shape[K], Fields<N, K>>
          : At<OpenCatchall<S>, Catchalls<N>>;
      }
    : DefOf<S> extends { type: "record"; valueType: infer V }
      ? { [K in keyof Out<S> as KeyName<K, N>]: At<V, Fields<N, K>> }
      : DefOf<S> extends { type: "array"; element: infer E }
        ? At<E, Elements<N, number>>[]
        : DefOf<S> extends {
              type: "tuple";
              items: infer Items extends readonly z.core.SomeType[];
              rest: infer R extends z.core.SomeType | null;
            }
          ? // The tuple's own output, rebuilt from its items so a brand on it does not turn it into an array.
            z.output<z.ZodTuple<Items, R>> extends infer O extends readonly unknown[]
            ? {
                -readonly [K in keyof O]: K extends `${number}`
                  ? K extends keyof Items
                    ? At<Items[K], Elements<N, K>>
                    : At<R, Elements<N, number>>
                  : At<R, Elements<N, number>>;
              }
            : never
          : DefOf<S> extends { type: "map"; keyType: infer K; valueType: infer V }
            ? Map<At<K, MapKeys<N>>, At<V, MapValues<N>>>
            : DefOf<S> extends { type: "set"; valueType: infer V }
              ? Set<At<V, SetElements<N>>>
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

/**
 * The schemas at element `K`: each array's element, and each tuple's item there. `number` is any element of an array,
 * which may sit at any tuple position or past them all, so it takes every item and the rest.
 */
type Elements<N, K> = N extends unknown
  ? DefOf<N> extends { type: "array"; element: infer E }
    ? E
    : DefOf<N> extends { type: "tuple"; items: infer Items extends readonly unknown[]; rest: infer R }
      ? K extends number
        ? Items[number] | Exclude<R, null>
        : K extends keyof Items
          ? Items[K]
          : Exclude<R, null>
      : never
  : never;
