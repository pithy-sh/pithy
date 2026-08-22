// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { InternalError } from "../error/pithyError";

/**
 * The reader's contract: a capability's own response object, restated for a client that does not
 * control the Worker that wrote the response.
 *
 * ## One schema, two consumers, two obligations
 *
 * A capability states each projection once, in its `http/responses.ts`, and both consumers validate
 * against it — the Worker's own tests and every management client. That is right for the fields and
 * wrong for the enums, because the two consumers are answering different questions.
 *
 * A **Worker validating its own projection is checking itself.** It must be strict: an enum there is
 * what the ingest path branches on and what D1 holds, and a tolerated-unknown member would license the
 * capability to *store* a value it cannot handle. Nothing here loosens that, and nothing here should:
 * the producer's enums are untouched, and this module never sees them at parse time.
 *
 * A **management client reading that response is crossing a trust boundary.** The system that wrote it
 * is a fork, a bug, a half-finished deploy, or hostile — none of which is downstream of how anybody's
 * releases are cut — and one member it has never heard of currently costs it the whole response rather
 * than the one row that carried it. A support console rendered zero of twenty-five conversations that
 * way (`pithy-sh/dashboard#15`), and the client that fixed it had to widen the kit's shape locally,
 * which is the mirror-of-a-projection that `#113` exists to forbid.
 *
 * So the tolerance is published **beside** the producer's shape rather than inside it. `asRead(X)` is
 * the whole pattern: the same object, with every enum reachable through it read as a string.
 *
 * ## What it is not
 *
 * **It is not a loosening.** A missing field, a number where a string belongs, a value outside a
 * numeric bound, a body that is not an object — all still refuse the whole response, exactly as before.
 * The only thing that changes is which *members* an enum-shaped field admits.
 *
 * **It is not a mapping.** The token is handed back verbatim. The enum stays the authority on what a
 * value means — `SupportChannel.safeParse(value).success` is the question, and the answer is the
 * client's license to *mark* the row. Reading an unrecognized value as the nearest one you know is a
 * lie about a fact somebody is about to act on, and this pattern exists to make marking cheap enough
 * that nobody reaches for mapping.
 *
 * **It is not selective.** A reader's obligation does not vary field by field: it does not control the
 * writer, so *any* unknown member costs it the response. Widening two enums and leaving a third is how
 * the same blank pane returns one field over.
 *
 * ## What it refuses to do
 *
 * It rewrites what it can see through — objects, arrays, `nullable`, `optional` — and returns anything
 * with no enum under it as the **identical schema instance**, so a reader's view and its producer share
 * every untouched field rather than copying it. Everything else throws at construction:
 * {@link asRead} either produces a view with no enum left in it or refuses to produce one, because a
 * shape that silently passed a union through would publish a "reader's contract" that still refuses an
 * unknown member — the original defect, wearing a name that says it was handled.
 */

/** What a widened field says about itself, appended to the description the enum already carried. */
export const TOLERATED_MEMBER =
  "Read as a string rather than as the enum it comes from: a client does not control the Worker that wrote this, so a member the enum does not declare is handed back verbatim instead of refusing the whole response. Ask the enum what a value means, mark what it does not declare, and never map it to the nearest value you know.";

/** The internal shape this module reads. Zod's own `def`, under either of the two spellings it has had. */
interface ZodDef {
  /** The type tag — `object`, `array`, `enum`, `nullable`, and the rest. */
  type?: string;
  /** An object's unknown-key rule, set by `.strict()` and `.loose()` and absent on a plain object. */
  catchall?: z.ZodType;
}

/** Read a schema's internal def, tolerating both the `_zod.def` and `.def` shapes across Zod builds. */
function defOf(schema: z.ZodType): ZodDef {
  const internal = schema as unknown as { _zod?: { def?: ZodDef }; def?: ZodDef };
  return internal._zod?.def ?? internal.def ?? {};
}

/**
 * The type tags that hold no other schema, so nothing inside one can be an enum.
 *
 * **Written out, never derived.** A permitted set computed from what the walk happens to handle would
 * grant an exemption to every kind somebody adds later, silently, which is the failure this roster is
 * here to prevent. A tag not on this list and not rewritten below is refused.
 *
 * `literal` is on it deliberately. A literal is not a vocabulary a capability might extend — it is how
 * a discriminated union tells its arms apart, and widening one would destroy the union rather than
 * tolerate anything.
 */
const LEAF_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "int",
  "bigint",
  "boolean",
  "date",
  "literal",
  "template_literal",
  "file",
  "symbol",
  "null",
  "undefined",
  "void",
  "any",
  "unknown",
  "never",
  "nan",
]);

/**
 * The refusal, with the offending schema's *path* in it and never a value.
 *
 * Thrown while a module is being evaluated, which is exactly where it belongs: a reader's contract is
 * built once at import, so a capability that cannot state one finds out in its own test run rather
 * than in front of a client.
 */
function unreadable(path: string, kind: string): InternalError {
  return new InternalError({
    message: "This projection has no reader's contract.",
    action: `State the reader's view of ${path} by hand, or reshape it so \`asRead\` can see through it.`,
    detail: `asRead met a \`${kind}\` at ${path}. It rewrites objects, arrays, nullable and optional wrappers, and refuses anything else rather than return a view that may still hold an enum a reader cannot survive.`,
  });
}

/** The refusal for an object whose unknown-key rule a rebuild would change. */
function unrebuildable(path: string): InternalError {
  return new InternalError({
    message: "This projection has no reader's contract.",
    action: `Drop the unknown-key rule on ${path}, or state its reader's view by hand.`,
    detail: `asRead met an object at ${path} that both holds an enum and declares its own unknown-key rule. Rebuilding it would silently change what it refuses, so it refuses to guess.`,
  });
}

/** A rebuilt schema wearing the description the original carried. Nothing is described twice. */
function describedLike<T extends z.ZodType>(rebuilt: T, original: z.ZodType): T {
  return original.description === undefined ? rebuilt : (rebuilt.describe(original.description) as T);
}

/**
 * One node of the rewrite. Returns the identical instance when nothing under it is an enum.
 *
 * The identity is not an optimization. It is what keeps a reader's view from becoming a second opinion
 * about the fields it did not widen: a field it shares with the producer is the *same object*, so a
 * change upstream lands in both, and a client can assert that field by field.
 */
function readerOf(schema: z.ZodType, path: string): z.ZodType {
  const { type, catchall } = defOf(schema);

  if (type === "enum") {
    const said = schema.description;
    return z.string().describe(said === undefined ? TOLERATED_MEMBER : `${said} ${TOLERATED_MEMBER}`);
  }

  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) {
    const inner = schema.unwrap() as z.ZodType;
    const read = readerOf(inner, path);
    if (read === inner) return schema;
    return describedLike(schema instanceof z.ZodNullable ? z.nullable(read) : z.optional(read), schema);
  }

  if (schema instanceof z.ZodArray) {
    const element = schema.element as z.ZodType;
    const read = readerOf(element, `${path}[]`);
    if (read === element) return schema;
    return describedLike(z.array(read), schema);
  }

  if (schema instanceof z.ZodObject) {
    const shape: Record<string, z.ZodType> = {};
    let widened = false;
    for (const [key, field] of Object.entries(schema.shape)) {
      const original = field as z.ZodType;
      const read = readerOf(original, `${path}.${key}`);
      shape[key] = read;
      if (read !== original) widened = true;
    }
    if (!widened) return schema;
    if (catchall !== undefined) throw unrebuildable(path);
    return describedLike(z.object(shape), schema);
  }

  if (type !== undefined && LEAF_TYPES.has(type)) return schema;
  throw unreadable(path, type ?? "schema of no stated type");
}

/**
 * The producer's schema with every enum under it read as a string.
 *
 * Enum in, string out; a wrapper keeps its own description and the widened member carries the enum's,
 * with {@link TOLERATED_MEMBER} appended so the schema still documents itself. Everything else is the
 * schema the capability declared, by identity.
 */
export type AsRead<T> = T extends z.ZodEnum
  ? z.ZodString
  : T extends z.ZodNullable<infer Inner>
    ? z.ZodNullable<Extract<AsRead<Inner>, z.ZodType>>
    : T extends z.ZodOptional<infer Inner>
      ? z.ZodOptional<Extract<AsRead<Inner>, z.ZodType>>
      : T extends z.ZodArray<infer Element>
        ? z.ZodArray<Extract<AsRead<Element>, z.ZodType>>
        : T extends z.ZodObject<infer Shape>
          ? z.ZodObject<{ [K in keyof Shape]: Extract<AsRead<Shape[K]>, z.ZodType> }>
          : T;

/**
 * A capability's response object, as a client that does not control the writer must read it.
 *
 * Export the result beside the producer's schema — `XAsRead` beside `X` — so a client imports tolerance
 * rather than building it. Throws if the projection holds a shape this cannot see through; see the
 * module docstring for why that is a refusal rather than a pass-through.
 */
export function asRead<T extends z.ZodType>(schema: T): AsRead<T> {
  return readerOf(schema, "response") as unknown as AsRead<T>;
}
