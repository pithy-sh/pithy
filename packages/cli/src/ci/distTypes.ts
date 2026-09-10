// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { blankComments } from "@pithy-sh/core/src/text/comments";
import { readSource, sourcePaths } from "./sourceFiles";

/**
 * **A `dist` that has silently lost its types passes every other gate in this repository.**
 *
 * The code compiles, the schemas parse, the tests pass, `pithy migrate` runs — and the shipped
 * declaration says `payloadRedactedAt: any` where the source says `SQLiteDate.nullish()`, in a `.d.ts`
 * 900 bytes shorter than the correct one (#523). Nothing here reads the declarations: every suite
 * imports the modules and asserts about *values*, and a value carries no evidence of the type that was
 * written down beside it. The only remaining detector was an adopter's `tsc`.
 *
 * So this is a consumer, generated from the shipped table list and compiled against `packages/*​/dist` —
 * the artifact an adopter installs, resolved the way an adopter resolves it, through each package's
 * `exports` map onto `./dist/*.d.ts`.
 *
 * ## Both halves of every schema, because an adopter compiles against both
 *
 * `z.input` is the SQLite row shape a repository **writes**; `z.output` is the app shape it **reads
 * back**. Adopter code is typed against both, so a run that reads one of them certifies half a package.
 * It read only `z.input` until the output side was degraded on purpose — `emailJob`'s `sendAt` to `any`,
 * confirmed by a probe compile — and this gate exited 0. Every assertion below is therefore generated
 * once per {@link Side}, from that side's own walk of the schema: a codec's `in` for input and its `out`
 * for output, which is why the value a field refuses is usually a different value on each side (`sendAt`
 * takes a number from SQLite and hands back a `Date`).
 *
 * ## Minimal is the whole point
 *
 * The failure is **optionality, not constructibility**. Degraded to `any`, a field's `_zod` internals
 * are unreachable, so neither `z.input` nor `z.output` can compute the key as optional and it reads as
 * **required**. A shape that supplies every field satisfies the precise type *and* the degraded one — it
 * carries strictly more information than either needs. The adopter code that broke, `devSeed.ts`, broke
 * because it **omits** that field.
 *
 * So each shape here is every key that side requires and **not one optional key more**. Written the
 * natural way — a realistic-looking full row — this gate would be green while an adopter is broken, which
 * is worse than no gate at all, because it also certifies what it missed.
 *
 * ## Four assertions per side, and not one of them is a list somebody maintains
 *
 * 1. **The shape** ({@link Assertion} `"shape"`). Every key that side requires, each filled by
 *    {@link CELL} — a typed hole, `declare function cell<T>(): T`, which is assignable to whatever the
 *    key demands and says nothing about it. It asserts the **key set**: a key that turned required fails
 *    with `Property 'x' is missing` ({@link MISSING_KEY}). Real values would assert nothing further,
 *    because a real value is assignable to `any` too.
 * 2. **A refused value** (`"value"`), which is the half a hole cannot state. `const x: z.input<typeof
 *    T>["field"] = 42` under a `@ts-expect-error`: precise, that is the expected error and it passes;
 *    degraded to `any`, the error **disappears** and TypeScript fails the build itself with
 *    {@link UNUSED_DIRECTIVE}, `TS2578: Unused '@ts-expect-error' directive`.
 * 3. **A refused `undefined`** (`"presence"`), for every key that side requires — the mirror of the
 *    shape. The shape catches optional becoming required; `= undefined` under a directive catches
 *    required becoming optional, because an optional key indexes to `T | undefined` and the directive
 *    goes unused.
 * 4. **Accepted values** (`"acceptance"`), one line per literal that side still permits — `null` where it
 *    is nullable, each arm where it is an enum — and these carry **no directive**, because they assert
 *    what the declaration must still accept. The first three all say what a type must *refuse*, and a
 *    type that merely **narrowed** still refuses everything it used to: `ZodNullable<ZodString>`
 *    flattened to `ZodString`, or `ZodEnum<{marketing, transactional}>` shipped with one arm, produce no
 *    diagnostic anywhere else in this repository. A narrowed declaration refuses the assignment and fails
 *    as {@link REFUSED_VALUE}.
 *
 * All four are self-maintaining, and for one reason: **every assertion is computed from `dist/*.js` and
 * checked against `dist/*.d.ts`.** A field that legitimately stops being nullable, or an enum that
 * legitimately loses an arm, stops being walked that way in the same build, so the line is simply not
 * written. There is no allowlist, no recorded count, and nothing to update when a field is added.
 *
 * The refused value is chosen per field from that side's own kinds, taking the first of
 * {@link REJECTIONS} the side does not admit: a number where the column takes a string, a string where it
 * takes a number, a boolean where it takes either, `null` where it takes any of them, then `{}` and `[]`.
 * A field that admits every one of those gets no value line and is covered by the shape alone — every
 * such field is named in {@link UNASSERTED} and repeated below.
 *
 * ## A failure names a field, not a line in a temp file
 *
 * `tsc` reports `rows.ts(416,7)` — a line in a generated program under `$TMPDIR` that will not exist by
 * the time anyone reads the CI log, in a file naming neither the package, the table, the side, nor the
 * field. The generator is the only thing that knows which assertion produced that line, so it records one
 * per line as it writes ({@link LineOrigin}) and {@link readDiagnostic} resolves it back. Each diagnostic
 * is printed under `<package> · <table>.<field> (<side>)` and the sentence for its shape, with the
 * compiler's own line kept verbatim beneath it.
 *
 * ## What it does not cover
 *
 * - **Anything but table schemas.** Request schemas, response schemas, capability config, the `Capability`
 *   contract itself, every function signature in the kit: none of it is read here. The tables are where
 *   #523 was observed and they are one enumerable population; the same degradation in a route handler's
 *   declaration is invisible to this gate.
 * - **One field's type, on both of its sides — `@pithy-sh/rating · pithyRatingRatings.state (input)` and
 *   `@pithy-sh/rating · pithyRatingRatings.state (output)`.** It is `sqliteJson(z.unknown())`, so both
 *   sides are `unknown` and there is no value TypeScript would refuse — degraded to `any` it reads
 *   exactly as it reads now, and the shape's key set is everything this gate can say about it. That is
 *   the whole list, and it is a list rather than a category on purpose: a reader has to be able to check
 *   the field they came here about, which "a field whose side admits everything" does not let them do. It
 *   measured 22 fields before `null` was added to {@link REJECTIONS} — every boolean column in the kit,
 *   because `SQLiteBoolean` decodes from `0 | 1 | boolean | string` and so admits all three scalars at
 *   once. {@link UNASSERTED} is the machine-readable copy and the tree is held to it exactly, so a
 *   twenty-third cannot arrive quietly and a closed one cannot linger.
 * - **Narrowing, wherever no literal can be derived.** {@link SchemaKey.admits} is what assertion 4 writes
 *   its undirected line from, and the walk yields one only for a nullable, an enum, or a literal union.
 *   633 of the 1054 field-sides have none, so for those a declaration that *narrows* — `string` to a
 *   subtype, a union losing an arm the walk could not enumerate — is green. Assertions 1 to 3 cannot
 *   see it either: each says what a type must **refuse**, and a narrowed type still refuses everything
 *   it used to. Measured against the finished gate rather than reasoned about.
 * - **Anything below the first level.** A field's type is read exactly one level deep, so a JSON
 *   column's inner object can lose a key or degrade a member to `any` and every assertion here still
 *   holds — which is the #523 defect itself, one level in. `sqliteJson(schema)` columns are where this
 *   bites, and there are enough of them to matter.
 * - **The declarations themselves.** The generated program compiles with `skipLibCheck`, like an
 *   adopter's, so a `.d.ts` that is internally broken but still answers `z.input` and `z.output`
 *   correctly passes here.
 * - **The source.** Both halves of this run read `dist`: the walk that computes each side's keys and
 *   picks its values imports `dist/*.js`, and the compile reads `dist/*.d.ts`. Nothing here opens
 *   `src/`. So a `dist` that is stale, or mis-built the same way on both sides, is green — setting
 *   `subject` to a number in `emailJob.js` **and** `emailJob.d.ts`, while `src` still says `z.string()`,
 *   exits 0. That is the same property that makes assertions 3 and 4 self-maintaining rather than an
 *   allowlist, and what bounds it is when it runs: CI runs it immediately after `Build`, so the window is
 *   a developer's own tree rather than a release. This gate asks whether a declaration still says what the
 *   value beside it says; `tsc` over `src` is what asks whether either still says what the source says.
 * - **Resolution and runtime.** Whether the tarball carries `dist`, whether `exports` points at it, and
 *   whether the JavaScript beside the declarations runs are the clean room's questions (`scripts/cleanRoom.ts`),
 *   not this one. This gate reads types out of a checkout that is already built.
 *
 * Four degradations that were on this list are now assertions instead, and a fifth that was never on it.
 * Each was closed by degrading a real shipped `.d.ts`, watching the gate fail, and restoring the file:
 * **the whole output side** (assertions 1–4 run per side, from that side's own walk), **a required field
 * becoming optional** (assertion 3), **an optional field's own type** (assertion 2, written for every key
 * rather than only the required ones — an optional key is absent from the shape by construction, so
 * before this its type could go to `any` unremarked), **a dropped nullability** and **an enum that lost an
 * arm** (assertion 4; the enum was found by trying it against the finished gate, which is the only way
 * this list has ever been right). Do not add a bullet back here without trying to slip the degradation
 * past the gate first: it has twice been wrong in the direction that costs a reader most, claiming less
 * coverage than existed and then more.
 *
 * ## The canary, so this is not another gate nobody has seen fail
 *
 * All three diagnostic codes are proven live on every run, against a real shipped table, before the
 * verdict is believed: a second tiny program omits a key the shipped declaration makes required
 * ({@link MISSING_KEY}), carries a `@ts-expect-error` over an assignment that is fine
 * ({@link UNUSED_DIRECTIVE}), and assigns a value the declaration refuses with no directive over it
 * ({@link REFUSED_VALUE}). Those are the three signals the real program is read for, and if any is absent
 * the compiler is not reporting what this gate reads, so the green from the first program means nothing.
 *
 * All three must also **read back to a field** through the same index the real report uses. An index is
 * only exercised by a failure, so on a green tree nothing else would ever touch it, and the run that
 * finally needed it would be the run that discovered it was wrong.
 */

/** `@ts-expect-error` over something that compiles. The refusal lines are only a gate because of this. */
const UNUSED_DIRECTIVE = "TS2578";

/** A required property missing from an object literal. What a key that degraded to required looks like. */
const MISSING_KEY = "TS2741";

/** A value the type will not take. What an acceptance line reports when a declaration has narrowed. */
const REFUSED_VALUE = "TS2322";

/** Every code the canary proves and the report reads, in the order the canary lists them. */
const CODES = [MISSING_KEY, UNUSED_DIRECTIVE, REFUSED_VALUE] as const;

/** The typed hole. It says "a value of whatever this key demands" and nothing whatever about the type. */
const CELL = "cell";

/**
 * Which half of a schema an assertion reads, and the `z.` type it is written with.
 *
 * `input` is the SQLite row an adopter's repository writes; `output` is the app shape it reads back from
 * `Schema.parse(row)`. Both are what an adopter compiles against, so both are generated — the same four
 * assertions, from the same walk, over each side's own kinds.
 */
export type Side = "input" | "output";

/** Both sides, in the order they are generated, so a table's block always reads write-then-read. */
export const SIDES: readonly Side[] = ["input", "output"];

/**
 * The exact population, both directions, held the way {@link UNASSERTED} is.
 *
 * It was a floor of 95% and that is not a check. Dropping `pithyLeaderboardEntries` from the shipped
 * `leaderboardTables()` left 45 tables in 16 packages, which cleared a floor of 43 in 15 and exited 0
 * reporting `45 tables … 454 of 455` — a walk that lost a table, passing. Slack was there so that
 * deleting a table would not be a red build; the cost of that convenience is that the one failure the
 * number exists to catch fits inside it.
 *
 * So the count is exact and moves only when a person decides it should: adding or removing a table is a
 * one-line edit here, in the same commit, and any other movement is the walk having lost the tree.
 * Measured on 2026-09-09.
 */
export const CENSUS = { tables: 46, packages: 16 };

/**
 * Where the generated programs are written — **outside the checkout, and that is forced**.
 *
 * Four turbo tasks are keyed on `$TURBO_ROOT$/**`, the whole tree, because what they read is the whole
 * tree. Turbo does not apply `.gitignore` to an explicit glob, so every artifact a run of this repository
 * writes has to be excluded by hand in `turbo.jsonc` or it is hashed into those keys — and an artifact
 * this gate writes on every run would make four cache keys that can never hit twice.
 * `packages/cli/src/ci/turboInputs.test.ts` is the gate that says so, and it caught this exact directory
 * while it lived at `packages/cli/.dist-types`.
 *
 * Named from the repository root rather than randomly, so a second run overwrites the first and a
 * failure names a path that is still there to open.
 */
export function fixtureRoot(root: string): string {
  return join(tmpdir(), `pithy-dist-types-${createHash("sha256").update(resolve(root)).digest("hex").slice(0, 8)}`);
}

/** What a zod schema exposes of itself at runtime, narrowed to the facts this file reads. */
interface ZodSchema {
  readonly _zod: {
    /** `"optional"` when the key may be omitted from the **input** — exactly what `z.input` keys on. */
    readonly optin?: unknown;
    /** `"optional"` when the key may be absent from the **output** — what `z.output` keys on. */
    readonly optout?: unknown;
    readonly def: ZodDef;
  };
}

/** The parts of a zod definition that decide a field's kind on one side. Every one is optional per type. */
interface ZodDef {
  readonly type: string;
  readonly shape?: Record<string, unknown>;
  /** A codec's or pipe's input side — what a row supplies. */
  readonly in?: unknown;
  /** A codec's or pipe's output side — what `Schema.parse(row)` hands back. */
  readonly out?: unknown;
  /** `optional`, `nullable`, `default`, `readonly`, … wrap one schema. */
  readonly innerType?: unknown;
  /** A union's members. */
  readonly options?: readonly unknown[];
  /** An enum's arms, by name. */
  readonly entries?: Record<string, unknown>;
  /** A literal's permitted values. */
  readonly values?: readonly unknown[];
}

/** One table the kit ships, resolved to the declaration an adopter imports. */
export interface ShippedTable {
  /** The package that contributes it, e.g. `@pithy-sh/email`. */
  readonly package: string;
  /** The table name as the schema map keys it, camelCase (`CamelCasePlugin` snake-cases the DDL). */
  readonly table: string;
  /** The specifier an adopter writes — `@pithy-sh/email/src/data/emailJob`, resolved onto `dist`. */
  readonly specifier: string;
  /** The exported name of the table's schema in that module. */
  readonly schema: string;
  /** Its keys, walked once per side, in declaration order. */
  readonly keys: Readonly<Record<Side, readonly SchemaKey[]>>;
}

/** One key of a table schema, as one side of it sees the key. */
export interface SchemaKey {
  /** The property name. */
  readonly field: string;
  /** True when this side requires the key — so the shape supplies it, and `undefined` is refused. */
  readonly present: boolean;
  /** A literal this side refuses, or null when it admits everything this file can name. */
  readonly rejected: string | null;
  /** Why that literal is refused — the sentence the `@ts-expect-error` carries. */
  readonly because: string;
  /**
   * Every value this side must still **accept**, as TypeScript literals: `null` where it is nullable,
   * and each arm where it is an enum, a literal or a union of them.
   *
   * The other three assertions all say what a type must refuse, and a type that quietly *narrowed* still
   * refuses everything it used to. A dropped `ZodNullable` and an enum that lost an arm are both that,
   * and both were invisible until this list existed.
   */
  readonly admits: readonly string[];
  /** True when this side's kinds are known at all — the precondition for the `undefined` assertion. */
  readonly known: boolean;
}

/** What a field's side accepts, coarsely — enough to pick a value it cannot. */
type Kind = "string" | "number" | "bigint" | "boolean" | "date" | "object" | "array" | "null";

/**
 * A value of a kind, and the sentence naming why a column that excludes that kind refuses it.
 *
 * **Read in order, first match wins, so this list only ever grows at the end.** A field takes the first
 * candidate its side does not admit; the three scalars are first because they are the ones whose
 * rejection reads like a sentence about a column. The candidates after them exist because three were not
 * enough: `SQLiteBoolean` decodes from `0 | 1 | boolean | string`, so a number, a string *and* a boolean
 * are all fine by it, and every one of the twenty-one boolean columns in the kit went uncovered on that
 * alone — degrading one of them to `any` in a shipped `.d.ts` was invisible here.
 *
 * `null` closes them: under `strictNullChecks` it is assignable to nothing but `null`, `any` and
 * `unknown`, and the whole mechanism turns on `any` accepting what the precise type refused. `{}` and
 * `[]` are reached only by a column that admits all four before them, which nothing in the kit does
 * today; they are here so that the next such column is covered rather than counted.
 *
 * A candidate the precise type *does* accept would fail the build as an unused directive — a red gate
 * for the wrong reason — so each is only ever chosen against a kind set this file computed, never
 * guessed, and {@link UNASSERTED} names what is left when every candidate is admitted.
 */
const REJECTIONS: readonly { readonly kind: Kind; readonly literal: string; readonly noun: string }[] = [
  { kind: "number", literal: "42", noun: "a number" },
  { kind: "string", literal: '"pithy"', noun: "a string" },
  { kind: "boolean", literal: "true", noun: "a boolean" },
  { kind: "null", literal: "null", noun: "null" },
  { kind: "object", literal: "{}", noun: "an object" },
  { kind: "array", literal: "[]", noun: "an array" },
];

/** Is this a zod schema? Structural, because the schema arrives from a `dist` module by dynamic import. */
function isSchema(value: unknown): value is ZodSchema {
  if (typeof value !== "object" || value === null || !("_zod" in value)) return false;
  const internals = (value as { _zod: unknown })._zod;
  return typeof internals === "object" && internals !== null && "def" in internals;
}

/** Is this a table schema — a zod object, which is what every table in the kit is? */
function isTableSchema(value: unknown): value is ZodSchema {
  return isSchema(value) && value._zod.def.type === "object";
}

/**
 * The kinds one **side** of a schema admits, or null when it admits something this file cannot name.
 *
 * The two sides differ at exactly one node — a pipe, which is what a codec is: `in` is the SQLite row
 * side a repository writes and `out` is the app side it reads back. `SQLiteDate` is a number, a string or
 * a `Date` going in and a `Date` coming out, so the value each side refuses is a different value, and
 * reading one side told this gate nothing about the other.
 *
 * Null is not a failure. It means no literal below is guaranteed to be refused, so the field gets the
 * shape and no value line — stated in the module docstring rather than papered over with a guess,
 * because a refusal line that TypeScript does not actually reject is a directive that fails the build
 * for the wrong reason.
 */
function sideKinds(schema: unknown, side: Side, depth = 0): Set<Kind> | null {
  if (depth > 8 || !isSchema(schema)) return null;
  const def = schema._zod.def;
  switch (def.type) {
    case "string":
    case "template_literal":
      return new Set<Kind>(["string"]);
    case "number":
    case "int":
    case "nan":
      return new Set<Kind>(["number"]);
    case "bigint":
      return new Set<Kind>(["bigint"]);
    case "boolean":
      return new Set<Kind>(["boolean"]);
    case "date":
      return new Set<Kind>(["date"]);
    case "null":
      return new Set<Kind>(["null"]);
    case "object":
    case "record":
    case "map":
    case "set":
    case "file":
    case "promise":
      return new Set<Kind>(["object"]);
    case "array":
    case "tuple":
      return new Set<Kind>(["array"]);
    case "enum":
      return literalKinds(Object.values(def.entries ?? {}));
    case "literal":
      return literalKinds(def.values ?? []);
    case "union":
      return unionKinds(def.options ?? [], side, depth);
    case "nullable":
      return widen(sideKinds(def.innerType, side, depth + 1), "null");
    case "optional":
    case "nonoptional":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "lazy":
      return sideKinds(def.innerType, side, depth + 1);
    case "pipe":
      // A codec is a pipe. `in` is the SQLite row a repository writes; `out` is what it reads back.
      return sideKinds(side === "input" ? def.in : def.out, side, depth + 1);
    default:
      return null;
  }
}

/** The kinds a set of literal values covers. An arm of a kind this file has no name for makes it null. */
function literalKinds(values: readonly unknown[]): Set<Kind> | null {
  const kinds = new Set<Kind>();
  for (const value of values) {
    if (value === null) kinds.add("null");
    else if (typeof value === "string") kinds.add("string");
    else if (typeof value === "number") kinds.add("number");
    else if (typeof value === "bigint") kinds.add("bigint");
    else if (typeof value === "boolean") kinds.add("boolean");
    else return null;
  }
  return kinds.size > 0 ? kinds : null;
}

/** A union admits every member's kinds; one member this file cannot name makes the whole union null. */
function unionKinds(options: readonly unknown[], side: Side, depth: number): Set<Kind> | null {
  const kinds = new Set<Kind>();
  for (const option of options) {
    const member = sideKinds(option, side, depth + 1);
    if (member === null) return null;
    for (const kind of member) kinds.add(kind);
  }
  return kinds.size > 0 ? kinds : null;
}

/** Add one kind to a set that may be null; null stays null. */
function widen(kinds: Set<Kind> | null, kind: Kind): Set<Kind> | null {
  if (kinds === null) return null;
  kinds.add(kind);
  return kinds;
}

/**
 * Every literal one **side** must still accept, as TypeScript source.
 *
 * The mirror of {@link sideKinds}, descending through exactly the same wrappers and stopping at the same
 * nodes, and collecting what those nodes *permit* rather than what they exclude. It is what closes the
 * degradations a refusal cannot see, because a narrowed type refuses everything the wide one did:
 * `ZodNullable<ZodString>` flattened to `ZodString`, and `ZodEnum<{marketing, transactional}>` shipped
 * with one arm — an adopter's `switch` narrows wrongly and nothing else in this repository notices.
 *
 * A `bigint` arm is skipped: it is the one literal kind whose TypeScript spelling (`1n`) is not what
 * `JSON.stringify` writes, and nothing in the kit has one. Add it here with its own spelling if that
 * changes.
 */
function sideAdmits(schema: unknown, side: Side, depth = 0): string[] {
  if (depth > 8 || !isSchema(schema)) return [];
  const def = schema._zod.def;
  switch (def.type) {
    case "null":
      return ["null"];
    case "enum":
      return literals(Object.values(def.entries ?? {}));
    case "literal":
      return literals(def.values ?? []);
    case "union":
      return unique((def.options ?? []).flatMap((option) => sideAdmits(option, side, depth + 1)));
    case "nullable":
      return unique([...sideAdmits(def.innerType, side, depth + 1), "null"]);
    case "optional":
    case "nonoptional":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "lazy":
      return sideAdmits(def.innerType, side, depth + 1);
    case "pipe":
      return sideAdmits(side === "input" ? def.in : def.out, side, depth + 1);
    default:
      return [];
  }
}

/** Literal values as TypeScript source. A kind with no safe spelling contributes nothing. */
function literals(values: readonly unknown[]): string[] {
  const written: string[] = [];
  for (const value of values) {
    if (value === null) written.push("null");
    else if (typeof value === "string" || typeof value === "number") written.push(JSON.stringify(value));
    else if (typeof value === "boolean") written.push(String(value));
  }
  return unique(written);
}

/** The same values, each once, in the order they were first seen. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Is the key required on this side? `optin` is what `z.input` reads; `optout` is what `z.output` reads. */
function requiredOn(schema: ZodSchema, side: Side): boolean {
  return (side === "input" ? schema._zod.optin : schema._zod.optout) !== "optional";
}

/** The sentence a refused value carries, phrased for the side that refuses it. */
function refusalSentence(field: string, noun: string, side: Side): string {
  return side === "input" ? `the ${field} column does not take ${noun}` : `${field} does not read back as ${noun}`;
}

/**
 * Every key of a table schema as one side sees it — required or not, what it refuses, whether it is
 * nullable.
 *
 * **Every key, not only the required ones.** An optional key is absent from the shape by construction —
 * that is the point of a minimal shape — so before its value line existed, an optional field's type
 * could degrade to `any` with nothing to say so. It is the same degradation as #523, in the half of the
 * schema the shape deliberately cannot reach.
 */
export function schemaKeys(schema: ZodSchema, side: Side): SchemaKey[] {
  const keys: SchemaKey[] = [];
  for (const [field, value] of Object.entries(schema._zod.def.shape ?? {})) {
    if (!isSchema(value)) continue;
    const kinds = sideKinds(value, side);
    const rejection = kinds === null ? undefined : REJECTIONS.find((candidate) => !kinds.has(candidate.kind));
    keys.push({
      field,
      present: requiredOn(value, side),
      rejected: rejection?.literal ?? null,
      because: rejection ? refusalSentence(field, rejection.noun, side) : "",
      admits: sideAdmits(value, side),
      known: kinds !== null,
    });
  }
  return keys;
}

/**
 * The fields that carry a shape and **nothing else**, named one at a time, side included.
 *
 * A category cannot be checked. "A field whose side admits everything" tells a reader nothing about the
 * field they came here about, and for the twenty-two fields this list held before {@link REJECTIONS}
 * grew, it read as an edge case while it was in fact every boolean column in the kit. So the exemption is
 * spelled `<package> · <table>.<field> (<side>)`, which is the form a reader can search for, and
 * {@link auditCoverage} holds the tree to exactly this list — not to its length.
 *
 * **The side is part of the spelling** because coverage is per side: a codec can be assertable going into
 * SQLite and unassertable coming back, and an entry that named only the field would hide whichever half
 * was still covered.
 *
 * **Exactly, in both directions.** A field that stops being assertable has to be named here, which is the
 * floor; a field that becomes assertable has to be *removed*, which is what stops the list decaying into
 * an allowlist nobody has reread. Either way the build says which field and why, and this docstring and
 * the module's own are the two places the answer is written down.
 *
 * The two entries are one field, `sqliteJson(z.unknown())`: both its sides are `unknown`, so there is no
 * value in any language TypeScript would refuse, degraded or not. It is not a gap that can be closed by
 * choosing a better value — it is a column that genuinely accepts anything, and the shape's key set is
 * all this gate can say about it.
 */
export const UNASSERTED: readonly string[] = [
  "@pithy-sh/rating · pithyRatingRatings.state (input)",
  "@pithy-sh/rating · pithyRatingRatings.state (output)",
];

/** How a field is spelled everywhere a reader has to match one: the exemption list and the report. */
export function fieldName(table: Pick<ShippedTable, "package" | "table">, field: string, side: Side): string {
  return `${table.package} · ${table.table}.${field} (${side})`;
}

/**
 * Every field this gate could find no value to refuse, on either side — the data behind {@link UNASSERTED}.
 *
 * Sorted, so the comparison is against a set rather than against a walk order, and printed in the same
 * spelling the constant uses so a failure can be pasted straight into it.
 */
export function unasserted(tables: readonly ShippedTable[]): string[] {
  return tables
    .flatMap((table) =>
      SIDES.flatMap((side) =>
        table.keys[side].filter((key) => key.rejected === null).map((key) => fieldName(table, key.field, side)),
      ),
    )
    .sort();
}

/**
 * Hold the population to {@link UNASSERTED} exactly, and say which way it moved.
 *
 * This is the assertion the count was: 22 of 464 required fields carried no rejection line, and nothing
 * in the repository would have noticed a twenty-third. A new table whose column admits every candidate is
 * covered by its shape's key set alone, which catches a field going from optional to required and misses a
 * field's type going to `any` — the failure this whole gate exists for.
 *
 * It runs against the built tree, so it lives here rather than in a suite: `distTypes.test.ts` holds the
 * mechanism, and `bun run dist-types` — which CI runs immediately after `Build` — holds the population.
 */
export function auditCoverage(tables: readonly ShippedTable[]): void {
  const found = unasserted(tables);
  const declared = new Set(UNASSERTED);
  const added = found.filter((field) => !declared.has(field));
  const removed = UNASSERTED.filter((field) => !found.includes(field));
  if (added.length === 0 && removed.length === 0) return;
  const lines: string[] = [];
  if (added.length > 0) {
    lines.push(
      added.length === 1
        ? "A field carries no refused value and no entry in UNASSERTED:"
        : `${added.length} fields carry no refused value and no entry in UNASSERTED:`,
      ...added.map((field) => `  ${field}`),
      "Each is covered by its shape's key set alone, so its type degrading to `any` would pass here.",
      "Give it a value that side refuses (REJECTIONS), or name it in UNASSERTED and in this module's",
      "docstring — a reader has to be able to check whether the field they care about is covered.",
    );
  }
  if (removed.length > 0) {
    lines.push(
      removed.length === 1
        ? "A field named in UNASSERTED now refuses a value:"
        : `${removed.length} fields named in UNASSERTED now refuse a value:`,
      ...removed.map((field) => `  ${field}`),
      "Delete them from UNASSERTED and from this module's docstring. The exemption is stale, and an",
      "exemption nobody rereads is how the list grew to twenty-two without anyone measuring it.",
    );
  }
  throw new Error(lines.join("\n"));
}

/**
 * Hold the walk to {@link CENSUS} exactly, in both directions.
 *
 * A floor is not a check. The one this replaced was 95% of the measured population, and dropping a whole
 * table from a shipped `tables.js` cleared it — 45 tables in 16 packages against a floor of 43 in 15,
 * reported as a pass. The exact number moves only when somebody edits it deliberately, in the commit that
 * adds or removes the table.
 */
export function auditCensus(tables: readonly ShippedTable[]): void {
  const packages = new Set(tables.map((table) => table.package)).size;
  if (tables.length === CENSUS.tables && packages === CENSUS.packages) return;
  throw new Error(
    [
      `The walk found ${tables.length} tables in ${packages} packages; CENSUS says ` +
        `${CENSUS.tables} in ${CENSUS.packages}.`,
      "If you added or removed a table, update CENSUS in packages/cli/src/ci/distTypes.ts in this commit.",
      "If you did not, the walk lost part of the tree — which is the failure a floor was too loose to see.",
    ].join("\n"),
  );
}

/** One `tables.ts` in the tree, and the built module that must answer for it. */
interface TableModule {
  /** The package name from its manifest. */
  readonly package: string;
  /** Absolute path to the package. */
  readonly root: string;
  /** The built module, absolute — `dist/data/tables.js` for `src/data/tables.ts`. */
  readonly built: string;
}

/** The `name` a package's manifest declares, or null when there is nothing readable to declare it. */
function packageName(packageRoot: string): string | null {
  const manifest = readSource(join(packageRoot, "package.json"));
  if (manifest === null) return null;
  const name: unknown = JSON.parse(manifest).name;
  return typeof name === "string" ? name : null;
}

/**
 * Every `tables.ts` this repository ships, paired with its built twin.
 *
 * **The population is the source tree, not the build.** A capability that has not been built is a
 * missing twin and a hard failure, which is the direction that matters: deriving the list from `dist`
 * would let an unbuilt package answer "no tables" and pass, which is the shape of gate this repository
 * keeps finding (`sweepPopulation.test.ts` holds the taxonomy).
 *
 * It leans on one convention — a capability's table map lives in a module named `tables.ts` — and
 * {@link uncoveredCapabilities} is what keeps that convention from being the way out of this gate.
 */
export function tableModules(root: string): TableModule[] {
  const packages = join(root, "packages");
  const modules: TableModule[] = [];
  for (const path of sourcePaths(packages, { keep: (name) => name === "tables.ts" })) {
    const inner = relative(packages, path);
    const [directory, ...rest] = inner.split(sep);
    if (directory === undefined || rest[0] !== "src") continue;
    const name = packageName(join(packages, directory));
    if (name === null) continue;
    modules.push({
      package: name,
      root: join(packages, directory),
      built: join(packages, directory, "dist", ...rest.slice(1)).replace(/\.ts$/, ".js"),
    });
  }
  return modules;
}

/**
 * The packages that contribute tables to a database and ship no `tables.ts` for this gate to read.
 *
 * **This is the half that makes the list impossible to opt out of.** {@link tableModules} finds table
 * maps by a naming convention, and a convention alone would mean a capability that keeps its map in
 * `schema.ts` is simply absent from the population — covered by nothing, reported by nothing, green.
 * So the question is asked from the other end as well: a `capability.ts` that declares `tables:` names a
 * package, and that package must be one this gate reads. Comments are blanked first, so a docblock
 * describing the contract is not mistaken for a capability declaring one.
 */
export function uncoveredCapabilities(root: string): string[] {
  const packages = join(root, "packages");
  const covered = new Set(tableModules(root).map((module) => module.root));
  const uncovered: string[] = [];
  for (const path of sourcePaths(packages, { keep: (name) => name === "capability.ts" })) {
    const text = readSource(path);
    if (text === null || !/\btables\s*:/.test(blankComments(text))) continue;
    const directory = relative(packages, path).split(sep)[0];
    if (directory !== undefined && !covered.has(join(packages, directory))) uncovered.push(relative(root, path));
  }
  return uncovered;
}

/**
 * Every table map a built module exports: a plain map, or a function whose arguments all have defaults.
 *
 * Both shapes are in the tree — `emailTables` is a const, `leaderboardTables()` is a function, and
 * `mediaTables(schema, options)` is a function whose parameters both default, so it answers to no
 * arguments like the rest. A function that needs an argument is not called and contributes nothing,
 * which {@link shippedTables} turns into a named failure rather than a silent absence.
 */
async function tablesIn(built: string): Promise<Record<string, ZodSchema>> {
  const module: Record<string, unknown> = await import(pathToFileURL(built).href);
  const tables: Record<string, ZodSchema> = {};
  for (const value of Object.values(module)) {
    let map: unknown = value;
    if (typeof value === "function" && value.length === 0) {
      try {
        map = (value as () => unknown)();
      } catch {
        continue;
      }
    }
    if (typeof map !== "object" || map === null || isSchema(map)) continue;
    const entries = Object.entries(map);
    if (entries.length === 0 || !entries.every(([, table]) => isTableSchema(table))) continue;
    for (const [name, table] of entries) tables[name] = table as ZodSchema;
  }
  return tables;
}

/**
 * Where a table's schema is declared, as the specifier an adopter would write.
 *
 * By **object identity**, not by name: the map holds the very schema the declaring module exported, so
 * the search cannot pick a same-named lookalike and cannot be fooled by a re-export. It looks only in
 * the tables module's own directory — `data/`, for every table in the kit — because importing a
 * package's whole `dist` would run modules that expect a Workers runtime.
 */
async function declaringModule(
  module: TableModule,
  table: ZodSchema,
): Promise<{ specifier: string; schema: string } | null> {
  const directory = dirname(module.built);
  const distRoot = join(module.root, "dist");
  for (const path of sourcePaths(directory, { keep: (name) => name.endsWith(".js") && !name.includes(".test.") })) {
    if (dirname(path) !== directory) continue;
    let exports: Record<string, unknown>;
    try {
      exports = await import(pathToFileURL(path).href);
    } catch {
      continue;
    }
    for (const [name, value] of Object.entries(exports)) {
      if (value !== table) continue;
      const inner = relative(distRoot, path).split(sep).join("/").replace(/\.js$/, "");
      return { specifier: `${module.package}/src/${inner}`, schema: name };
    }
  }
  return null;
}

/**
 * Every table the kit ships, resolved to a declaration and walked once per side.
 *
 * Throws rather than skipping, in all three ways it can fail: a package that is not built, a tables
 * module that exports no map, and a schema whose declaring module cannot be found. Each of those is a
 * table this gate would otherwise cover in name only.
 */
export async function shippedTables(root: string): Promise<ShippedTable[]> {
  const shipped: ShippedTable[] = [];
  const uncovered = uncoveredCapabilities(root);
  if (uncovered.length > 0) {
    throw new Error(
      `${uncovered.join(", ")} declares tables this gate cannot read. ` +
        "A capability's table map goes in a module named tables.ts, which is how this gate finds it.",
    );
  }
  const modules = tableModules(root);
  for (const module of modules) {
    if (!existsSync(module.built)) {
      throw new Error(`${module.package} is not built: ${relative(root, module.built)} is missing. Run bun run build.`);
    }
    const tables = await tablesIn(module.built);
    if (Object.keys(tables).length === 0) {
      throw new Error(
        `${relative(root, module.built)} exports no table map. This gate reads the kit's tables from it.`,
      );
    }
    for (const [table, schema] of Object.entries(tables)) {
      const declared = await declaringModule(module, schema);
      if (declared === null) {
        throw new Error(
          `${module.package} table ${table} has no declaring module beside ${basename(module.built)}. ` +
            "This gate imports a table's schema from where it is declared, so it must sit in that directory.",
        );
      }
      shipped.push({
        package: module.package,
        table,
        ...declared,
        keys: { input: schemaKeys(schema, "input"), output: schemaKeys(schema, "output") },
      });
    }
  }
  return shipped.sort((left, right) => left.table.localeCompare(right.table));
}

/** The generated program's own header — what it is, and the one thing to do when it fails. */
const FIXTURE_HEADER = `// Generated by packages/cli/src/ci/distTypes.ts, outside the checkout on purpose — four turbo tasks are
// keyed on the whole tree and would hash this. Regenerated every run; editing it changes nothing.
//
// Per shipped table, per side: one minimal shape of \`z.input\` and one of \`z.output\`, compiled against
// packages/*/dist — the declarations an adopter consumes, on the write side and the read side both. Every
// key that side requires, and not one optional key more: the failure this exists to catch is a field that
// degrades to \`any\`, which neither side can then read as optional, so it turns up here as a key that is
// suddenly missing. Beside each shape: a value the field refuses, an \`undefined\` it refuses, and — with
// no directive, because it asserts what must still be accepted — a \`null\` where the schema is nullable.
//
// A failure here means a built .d.ts no longer says what its source says. Rebuild the named package
// from clean (rm -rf packages/<name>/dist && bun run build) and run \`bun run dist-types\` again; if it
// still fails, the source and the declaration genuinely disagree.
//
// What this does not cover is written down in packages/cli/src/ci/distTypes.ts.
`;

/** The typed hole, declared once per program. */
const CELL_DECLARATION = `/** A value of whatever type the key demands, asserting nothing about it. The key set is the assertion. */
declare function ${CELL}<T>(): T;
`;

/** Which of the four things a generated line asserts. The report says a different sentence for each. */
export type Assertion = "shape" | "value" | "presence" | "acceptance";

/**
 * What one line of the generated program asserts — the half a diagnostic does not carry.
 *
 * `tsc` reports a line number in a file under `$TMPDIR` that will not exist when anybody reads the CI log.
 * The generator is the only thing that knows which field, which side and which assertion produced that
 * line, so it says so as it writes, and {@link readDiagnostics} resolves it back. Without this a failure
 * reads as `rows.ts(416,7)` and names none of them — a gate whose whole point is to make a silent failure
 * loud, reporting it in a form nobody can act on.
 */
export interface LineOrigin {
  /** The package whose declaration the line reads. */
  readonly package: string;
  /** The table the line is about. */
  readonly table: string;
  /** Which half of the schema it reads. */
  readonly side: Side;
  /** Which of the four assertions it is. */
  readonly assertion: Assertion;
  /** The field the line asserts, or null for a shape — a missing key names its own in the message. */
  readonly key: SchemaKey | null;
}

/** One line of the generated program, and what it asserts. The index is built from these, never beside them. */
interface FixtureLine {
  /** The line, verbatim. */
  readonly text: string;
  /** What it asserts, or null for the header, the imports and the blank lines between blocks. */
  readonly origin: LineOrigin | null;
}

/** A generated program: what to write, and how to read a diagnostic's line number back to a field. */
export interface Fixture {
  /** The program. */
  readonly source: string;
  /** 1-based line number → what that line asserts. Lines that assert nothing are absent. */
  readonly origins: ReadonlyMap<number, LineOrigin>;
}

/**
 * One side of one table: its shape, then its per-field assertions.
 *
 * Each directive is **one line above one line**, never wrapped: `@ts-expect-error` suppresses the line
 * that follows it, and a declaration split across two lines can report its error on either.
 *
 * The acceptance lines are the ones with no directive over them. They say the declaration must still
 * *accept* something, which is a shape no `@ts-expect-error` can express — a directive asserts an error,
 * and a type that merely narrowed produces none.
 */
function sideLines(table: ShippedTable, side: Side): FixtureLine[] {
  const at = (key: SchemaKey | null, assertion: Assertion): LineOrigin => ({
    package: table.package,
    table: table.table,
    side,
    assertion,
    key,
  });
  const type = `z.${side}<typeof ${table.schema}>`;
  const keys = table.keys[side];
  const lines: FixtureLine[] = [{ text: `const shape_${side}_${table.table}: ${type} = {`, origin: at(null, "shape") }];
  for (const key of keys) {
    if (key.present) lines.push({ text: `  ${JSON.stringify(key.field)}: ${CELL}(),`, origin: at(key, "shape") });
  }
  lines.push({ text: "};", origin: at(null, "shape") });
  for (const key of keys) {
    const member = `${type}[${JSON.stringify(key.field)}]`;
    const name = (prefix: string) => `${prefix}_${side}_${table.table}_${key.field}`;
    if (key.rejected !== null) {
      lines.push({ text: `// @ts-expect-error ${key.because}.`, origin: at(key, "value") });
      lines.push({ text: `const ${name("no")}: ${member} = ${key.rejected};`, origin: at(key, "value") });
    }
    if (key.present && key.known) {
      lines.push({ text: `// @ts-expect-error ${presenceSentence(key.field, side)}.`, origin: at(key, "presence") });
      lines.push({ text: `const ${name("gone")}: ${member} = undefined;`, origin: at(key, "presence") });
    }
    key.admits.forEach((literal, arm) => {
      lines.push({ text: `const ${name(`ok${arm}`)}: ${member} = ${literal};`, origin: at(key, "acceptance") });
    });
  }
  return lines;
}

/** Why a required key refuses `undefined`, phrased for the side that requires it. */
function presenceSentence(field: string, side: Side): string {
  return side === "input" ? `a row cannot omit ${field}` : `${field} is always read back`;
}

/** One table's block: a comment naming it, then both sides. */
function tableLines(table: ShippedTable): FixtureLine[] {
  return [
    { text: "", origin: null },
    { text: `// ${table.package} · ${table.table}`, origin: null },
    ...SIDES.flatMap((side) => sideLines(table, side)),
  ];
}

/** One table's block, as text. The program is the same lines, indexed. */
export function renderTable(table: ShippedTable): string {
  return tableLines(table)
    .map((line) => line.text)
    .join("\n");
}

/** Lines that assert nothing: a header, an import, a blank. */
function plain(text: readonly string[]): FixtureLine[] {
  return text.map((line) => ({ text: line, origin: null }));
}

/** Number the lines, so a diagnostic's `(line,column)` resolves to the field that produced it. */
function index(lines: readonly FixtureLine[]): Fixture {
  const origins = new Map<number, LineOrigin>();
  lines.forEach((line, offset) => {
    if (line.origin !== null) origins.set(offset + 1, line.origin);
  });
  return { source: lines.map((line) => line.text).join("\n"), origins };
}

/** The program: one import per table, and one block per table carrying both sides' assertions. */
export function renderFixture(tables: readonly ShippedTable[]): Fixture {
  const imports = tables.map((table) => `import type { ${table.schema} } from ${JSON.stringify(table.specifier)};`);
  return index([
    ...plain(FIXTURE_HEADER.split("\n")),
    ...plain(['import type { z } from "zod";']),
    ...plain([...new Set(imports)].sort()),
    ...plain([""]),
    ...plain(CELL_DECLARATION.split("\n")),
    ...tables.flatMap(tableLines),
    ...plain([""]),
  ]);
}

/**
 * The canary: the three assertions, deliberately wrong, over a real shipped table.
 *
 * It must fail with all three codes. A shape missing a key the declaration requires proves the compiler
 * reports {@link MISSING_KEY} here; a `@ts-expect-error` over an assignment that is fine proves it
 * reports {@link UNUSED_DIRECTIVE}; an undirected assignment of a value the declaration refuses proves it
 * reports {@link REFUSED_VALUE}, which is what a `null` line is read for. Those are the three signals the
 * real program is read for, and a gate that has never seen one of them fire is a gate nobody has seen
 * fail.
 *
 * It is indexed like the real program, so the same run proves the **second** thing a reader needs: that
 * all three diagnostics resolve back to a package, a table, a side and a field. A line index is only
 * exercised by a failure, so on a green tree nothing else would ever read it.
 */
export function renderCanary(table: ShippedTable): Fixture {
  const keys = table.keys.input;
  const dropped = keys.find((key) => key.present);
  const refused = keys.find((key) => key.rejected !== null);
  if (dropped === undefined) throw new Error(`${table.table} has no required key, so the canary cannot omit one.`);
  if (refused === undefined) throw new Error(`${table.table} refuses no value, so the canary cannot assign one.`);
  const at = (key: SchemaKey | null, assertion: Assertion): LineOrigin => ({
    package: table.package,
    table: table.table,
    side: "input",
    assertion,
    key,
  });
  const type = `z.input<typeof ${table.schema}>`;
  return index([
    ...plain([
      "// Generated by packages/cli/src/ci/distTypes.ts. This program MUST NOT compile — see renderCanary.",
      'import type { z } from "zod";',
      `import type { ${table.schema} } from ${JSON.stringify(table.specifier)};`,
      "",
    ]),
    ...plain(CELL_DECLARATION.split("\n")),
    ...plain([`// Omits ${dropped.field}, which the shipped declaration makes required.`]),
    { text: `const shape: ${type} = {`, origin: at(null, "shape") },
    ...keys
      .filter((key) => key.present && key !== dropped)
      .map((key) => ({ text: `  ${JSON.stringify(key.field)}: ${CELL}(),`, origin: at(key, "shape") })),
    { text: "};", origin: at(null, "shape") },
    { text: "// @ts-expect-error this assignment is fine, so the directive is unused.", origin: at(dropped, "value") },
    {
      text: `const fine: ${type}[${JSON.stringify(dropped.field)}] = ${CELL}();`,
      origin: at(dropped, "value"),
    },
    ...plain([`// ${refused.because}, and nothing suppresses the error — what an acceptance line is read for.`]),
    {
      text: `const refused: ${type}[${JSON.stringify(refused.field)}] = ${refused.rejected};`,
      origin: at(refused, "acceptance"),
    },
    ...plain([""]),
  ]);
}

/**
 * An adopter's compiler settings, near enough.
 *
 * `Bundler` resolution and `skipLibCheck` are what a Vite or Wrangler project ships with, and
 * `skipLibCheck` in particular is deliberate: this asks what the declarations *say*, not whether they
 * are internally sound, and lib errors from a dependency would make the verdict about somebody else.
 */
const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "strict": true,
    "skipLibCheck": true,
    "types": [],
    "noEmit": true
  },
  "include": ["*.ts"]
}
`;

/** Write one program — its own directory, so each compiles alone and a failure names the right one. */
export function writeProgram(directory: string, file: string, source: string): void {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(directory, file), source);
}

/**
 * The `node_modules` the generated programs resolve through: one symlink per workspace package, plus zod.
 *
 * This is what makes the programs adopter-shaped rather than repo-shaped. They sit outside the checkout,
 * so nothing is in scope for them by accident: every specifier they write is resolved the way an
 * adopter's is, by finding `@pithy-sh/<name>` in a `node_modules` and following its `exports` map onto
 * `./dist/*.d.ts`. A symlink is what a workspace install puts there too, and TypeScript resolves through
 * it to the real package the same way.
 */
function linkPackages(root: string, directory: string): void {
  const modules = join(directory, "node_modules");
  const scope = join(modules, "@pithy-sh");
  mkdirSync(scope, { recursive: true });
  for (const entry of readdirSync(join(root, "packages"))) {
    const name = packageName(join(root, "packages", entry));
    if (name === null) continue;
    link(join(root, "packages", entry), join(scope, name.replace("@pithy-sh/", "")));
  }
  link(join(root, "packages", "cli", "node_modules", "zod"), join(modules, "zod"));
}

/** One symlink, replaced rather than reused — a link left over from a moved package would resolve nowhere. */
function link(target: string, path: string): void {
  rmSync(path, { force: true });
  symlinkSync(target, path, "dir");
}

/** The repository's own TypeScript — the version the kit is built with, not whatever is on the PATH. */
export function typescript(root: string): string {
  return join(root, "packages", "cli", "node_modules", ".bin", "tsc");
}

/** What `tsc` said about one program. */
export interface Compilation {
  /** True when it compiled clean. */
  readonly clean: boolean;
  /** Its diagnostics, verbatim — the sentences a reader needs and this file must not rewrite. */
  readonly output: string;
}

/**
 * Compile one program with the repository's own TypeScript — the version the kit is built with.
 *
 * From inside the program's directory, so a diagnostic reads `rows.ts(415,7)` rather than a relative
 * path back out of the checkout. The directory itself is named once, in the verdict, and the line number
 * is read back to a field by {@link readDiagnostic}.
 *
 * It takes the compiler rather than a root to derive one from, and is exported with {@link writeProgram}
 * so `distTypes.test.ts` can put a deliberately degraded declaration in front of the real compiler under
 * these exact settings — the line numbers the index is read against have to come from `tsc`, not from a
 * fixture of what `tsc` is assumed to print. That suite then reaches its own package's `node_modules` and
 * climbs out of `packages/cli` for nothing, which is what keeps it package-scoped in
 * `turboInputs.test.ts`'s register.
 */
export function compile(tsc: string, directory: string): Compilation {
  if (!existsSync(tsc)) throw new Error(`No TypeScript at ${tsc}. Run bun install.`);
  try {
    execFileSync(tsc, ["-p", "tsconfig.json"], { cwd: directory, encoding: "utf8", stdio: "pipe" });
    return { clean: true, output: "" };
  } catch (failure) {
    const reported = failure as { stdout?: string; stderr?: string };
    return { clean: false, output: `${reported.stdout ?? ""}${reported.stderr ?? ""}`.trim() };
  }
}

/** One error line of `tsc` output, split far enough to look up what the line it points at asserts. */
const DIAGNOSTIC = /^[^(\s][^(]*\((\d+),\d+\): error (TS\d+): (.*)$/;

/** The property a {@link MISSING_KEY} names. The shape line cannot say which key is gone; the message can. */
const MISSING_PROPERTY = /^Property '([^']+)' is missing/;

/** One diagnostic, and what this gate can say about it beyond the compiler's own words. */
export interface Diagnostic {
  /** The line `tsc` printed, verbatim. */
  readonly raw: string;
  /** Its error code, e.g. `TS2578`. */
  readonly code: string;
  /** `<package> · <table>.<field> (<side>)`, or null when the line is not one this gate generated. */
  readonly where: string | null;
  /** What changed, in this gate's words — null for a line it does not read. */
  readonly meaning: string | null;
}

/**
 * What a diagnostic on one of this gate's lines means, in this gate's words.
 *
 * Each assertion fails in exactly one way, and the sentence is about that way. A {@link MISSING_KEY} on a
 * shape says a key turned required; a {@link UNUSED_DIRECTIVE} on a value line says the declaration
 * stopped refusing something and on a presence line that it started admitting `undefined`; anything at
 * all on an acceptance line says the declaration stopped admitting a value the schema still permits,
 * since those lines carry no directive and a clean tree never reports on one.
 */
function meaningOf(code: string, origin: LineOrigin): string | null {
  const { side, assertion, key } = origin;
  if (assertion === "shape" && code === MISSING_KEY) {
    return `required by the shipped declaration's ${side} side, optional in the schema beside it`;
  }
  if (assertion === "value" && code === UNUSED_DIRECTIVE && key?.rejected != null) {
    return `the shipped declaration's ${side} side accepts ${key.rejected}, though ${key.because}`;
  }
  if (assertion === "presence" && code === UNUSED_DIRECTIVE && key !== null) {
    return `the shipped declaration lets ${key.field} be undefined on the ${side} side, though the schema requires it`;
  }
  if (assertion === "acceptance" && key !== null) {
    return `the shipped declaration's ${side} side refuses a value ${key.field} still admits (${key.admits.join(", ")})`;
  }
  return null;
}

/**
 * Read one line of `tsc` output back to the field that produced it.
 *
 * A {@link MISSING_KEY} sits on a shape's declaration, which knows the table but not which key went
 * missing — the compiler names that in its message, so it is taken from there rather than guessed. Every
 * other line knows its own field.
 */
export function readDiagnostic(raw: string, origins: ReadonlyMap<number, LineOrigin>): Diagnostic | null {
  const match = DIAGNOSTIC.exec(raw);
  if (match === null) return null;
  const [, line = "", code = "", message = ""] = match;
  const origin = origins.get(Number(line));
  if (origin === undefined) return { raw, code, where: null, meaning: null };
  const field = origin.key?.field ?? MISSING_PROPERTY.exec(message)?.[1] ?? null;
  const where =
    field === null ? `${origin.package} · ${origin.table} (${origin.side})` : fieldName(origin, field, origin.side);
  return { raw, code, where, meaning: meaningOf(code, origin) };
}

/** Every diagnostic in a compilation, in the order `tsc` reported them. */
export function readDiagnostics(output: string, origins: ReadonlyMap<number, LineOrigin>): Diagnostic[] {
  return output
    .split("\n")
    .map((raw) => readDiagnostic(raw, origins))
    .filter((diagnostic): diagnostic is Diagnostic => diagnostic !== null);
}

/**
 * The compiler's output with each diagnostic named — package, table, side, field, and what changed.
 *
 * **The diagnostics stay verbatim.** They are the compiler's own words and the only ones that carry a
 * column, a type and a reason; this adds the sentence they cannot, above each one, and indents the
 * original under it. A line it cannot place — a resolution failure, a summary — passes through untouched,
 * because a report that swallowed what it did not understand would be the same defect one layer up.
 */
export function explainDiagnostics(output: string, origins: ReadonlyMap<number, LineOrigin>): string {
  const explained: string[] = [];
  for (const raw of output.split("\n")) {
    const diagnostic = readDiagnostic(raw, origins);
    if (diagnostic === null || diagnostic.where === null) {
      explained.push(raw);
      continue;
    }
    explained.push(
      diagnostic.meaning === null ? `${diagnostic.where}:` : `${diagnostic.where} — ${diagnostic.meaning}.`,
    );
    explained.push(`  ${raw}`);
  }
  return explained.join("\n");
}

/** The verdict: an exit code and the text to print. */
export interface Verdict {
  /** 0 when every shipped declaration still says on both sides what its schema says. */
  readonly code: number;
  /** What to print. English, greppable, and the diagnostics unedited. */
  readonly output: string;
}

/** What the run asserted, counted per side, so a green line is worth reading rather than just green. */
function census(tables: readonly ShippedTable[]): string {
  const packages = new Set(tables.map((table) => table.package)).size;
  const count = (pick: (key: SchemaKey) => boolean) =>
    tables.reduce((total, table) => total + SIDES.reduce((n, s) => n + table.keys[s].filter(pick).length, 0), 0);
  const fields = count(() => true);
  const admitted = tables.reduce(
    (total, table) => total + SIDES.reduce((n, s) => n + table.keys[s].reduce((m, key) => m + key.admits.length, 0), 0),
    0,
  );
  const values = count((key) => key.rejected !== null);
  const exempt = fields - values;
  return (
    `${tables.length} tables from ${packages} packages, both sides: ` +
    `${values} of ${fields} fields refuse a value, ${count((key) => key.present && key.known)} refuse undefined, ` +
    `${admitted} values must still be accepted; ` +
    `${exempt === 1 ? "1 field carries" : `${exempt} fields carry`} a shape and nothing else (UNASSERTED).`
  );
}

/**
 * Generate both programs, compile both, and hold the answers to what each one is for.
 *
 * The canary is compiled **first**. Its failure means the compiler is not reporting what this gate
 * reads, and a green from the real program in that state is worth nothing — so it is checked before
 * the verdict rather than beside it.
 */
export async function checkDistTypes(root: string): Promise<Verdict> {
  const tables = await shippedTables(root);
  auditCensus(tables);
  auditCoverage(tables);
  const directory = fixtureRoot(root);
  linkPackages(root, directory);

  const first = tables[0];
  if (first === undefined) throw new Error("No shipped tables found. This gate cannot be vacuous.");

  const canaryDirectory = join(directory, "canary");
  const canaryProgram = renderCanary(first);
  writeProgram(canaryDirectory, "canary.ts", canaryProgram.source);
  const canary = compile(typescript(root), canaryDirectory);
  const missing = CODES.filter((code) => !canary.output.includes(code));
  if (missing.length > 0) {
    return {
      code: 1,
      output: [
        `The canary did not fail the way this gate reads: ${missing.join(" and ")} not reported.`,
        `It compiles ${canaryDirectory}, which omits a required key, carries an unused @ts-expect-error,`,
        "and assigns a value the declaration refuses. All three must be errors, or a pass from the real",
        "program proves nothing.",
        canary.output || "tsc reported nothing at all.",
      ].join("\n"),
    };
  }
  const located = readDiagnostics(canary.output, canaryProgram.origins);
  const unplaced = CODES.filter(
    (code) => !located.some((diagnostic) => diagnostic.code === code && diagnostic.where !== null),
  );
  if (unplaced.length > 0) {
    return {
      code: 1,
      output: [
        `The canary's diagnostics do not read back to a field: ${unplaced.join(" and ")} landed on no line`,
        "this gate generated. The line index is what turns a failure into a package, a table, a side and a",
        `field, and a failure that names only ${basename(canaryDirectory)}.ts(N,N) is one nobody can act on.`,
        canary.output,
      ].join("\n"),
    };
  }

  const rowsDirectory = join(directory, "rows");
  const rowsProgram = renderFixture(tables);
  writeProgram(rowsDirectory, "rows.ts", rowsProgram.source);
  const rows = compile(typescript(root), rowsDirectory);
  const counted = census(tables);
  if (rows.clean) return { code: 0, output: `Every shipped declaration still says what its schema says. ${counted}` };
  return {
    code: 1,
    output: [
      "A shipped declaration no longer says what its schema says.",
      `${MISSING_KEY} is a field that degraded and can no longer be read as optional; ${UNUSED_DIRECTIVE} is a`,
      `type that stopped refusing what it used to refuse; ${REFUSED_VALUE} is one that narrowed, and stopped`,
      "admitting a value the schema still permits.",
      "",
      explainDiagnostics(rows.output, rowsProgram.origins),
      "",
      `The program is at ${rowsDirectory}. ${counted}`,
    ].join("\n"),
  };
}
