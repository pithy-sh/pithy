// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The gate primitive for a projection that crosses a trust boundary: **nothing left this surface but the
 * facts it publishes.**
 *
 * Every such gate in this kit was first written as its negative — a list of strings that must not appear
 * in the response. A negative list is complete only against the values somebody thought of, and a
 * projection widens by gaining a *field*, which is exactly the event a value list cannot observe. The
 * same argument has been lost here three times over: a tripwire banning `access` while `stat` followed
 * links identically, an escape class that arrived as three different verbs, and a bundle sweep seeded
 * with the credential shapes of the day.
 *
 * So the rule is stated positively and computed rather than enumerated. Two halves, and **both are
 * required, because either alone lets the mistake through**:
 *
 * 1. **Every leaf must be a published fact.** This is what catches a forbidden value arriving under a
 *    field name nobody predicted.
 * 2. **Every key must be a published key.** This is what catches a leaf whose *type* has no vocabulary —
 *    `true`, `false` and `null` belong to every JSON document, so the first half can never police them,
 *    and a new `boolean` field is the cheapest way to widen a projection.
 *
 * ## Two rules for the caller, and both were paid for
 *
 * **Write the permitted key set out by hand.** Deriving it from `Object.keys(Schema.shape)` makes the
 * gate read its own subject: the edit that widens the schema widens the permission, in the same commit,
 * and the test whose entire job is to catch that passes. That happened, on the catalog read.
 *
 * **Seed the source with something forbidden of every JSON type.** A sweep over a document that never
 * held anything secret passes perfectly and proves nothing. The leaf walk below once returned `[]` for
 * every type that was not a string or a number, so booleans and nulls crossed untouched — nothing
 * forbidden happened to be a boolean that day, which is what kept it from being a live leak, not what
 * made it safe.
 *
 * ## Why it throws
 *
 * A value this walk cannot name is a silent exemption for a whole JSON type, granted by a fallthrough.
 * That is the defect above, restated. So {@link unpublishedIn} refuses the document instead — `undefined`,
 * a function, a `bigint` or a symbol means the caller handed it a live JavaScript object rather than
 * what a client receives. Round-trip through `JSON.parse(JSON.stringify(...))` first: that is what
 * crosses, and what crosses is what a gate is about.
 */

/** Anything a JSON document holds that is not an object or an array. */
export type JsonLeaf = string | number | boolean | null;

/**
 * What one surface is allowed to publish: the facts, and the field names they may sit under.
 *
 * `keys` is a literal written at the call site. Never `Object.keys` of the schema being policed — see
 * the note above.
 */
export interface PublishedFacts {
  /** Every value this surface may disclose, from wherever it legitimately came. */
  readonly leaves: Iterable<JsonLeaf>;
  /** Every object key this surface may carry, at any depth. Written out by hand. */
  readonly keys: Iterable<string>;
}

/**
 * Everything in `document` that {@link PublishedFacts} does not permit, as lines naming what and where.
 *
 * Empty means the projection published only what it declared. A non-empty result is the message: each
 * line carries the offending key or value and its JSON path, so a failure says which field widened
 * rather than that some string was present.
 *
 * @param document A JSON document — what a client actually receives, not a live object.
 * @param published The facts and keys this surface declares.
 * @throws If `document` holds a value JSON cannot express.
 */
export function unpublishedIn(document: unknown, published: PublishedFacts): string[] {
  const leaves = new Set<JsonLeaf>(published.leaves);
  const keys = new Set<string>(published.keys);
  const found: string[] = [];
  walk(document, "", leaves, keys, found);
  return found;
}

/** Every leaf in a JSON document, wherever it sits, of every JSON type. Object keys are collected separately. */
export function leavesIn(document: unknown): JsonLeaf[] {
  if (Array.isArray(document)) return document.flatMap(leavesIn);
  if (document !== null && typeof document === "object") return Object.values(document).flatMap(leavesIn);
  return [asLeaf(document, "")];
}

/** Every object key in a JSON document, wherever it sits. */
export function keysIn(document: unknown): string[] {
  if (Array.isArray(document)) return document.flatMap(keysIn);
  if (document !== null && typeof document === "object") {
    return Object.entries(document).flatMap(([key, nested]) => [key, ...keysIn(nested)]);
  }
  return [];
}

function walk(
  value: unknown,
  path: string,
  leaves: ReadonlySet<JsonLeaf>,
  keys: ReadonlySet<string>,
  found: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walk(item, `${path}[${index}]`, leaves, keys, found);
    });
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      const here = path === "" ? key : `${path}.${key}`;
      if (!keys.has(key)) found.push(`key ${JSON.stringify(key)} at ${here}`);
      walk(nested, here, leaves, keys, found);
    }
    return;
  }
  const leaf = asLeaf(value, path);
  if (!leaves.has(leaf)) found.push(`value ${JSON.stringify(leaf)} at ${path === "" ? "(root)" : path}`);
}

/** Narrow to a JSON leaf, or refuse the document. A type this walk cannot name is not a type it may skip. */
function asLeaf(value: unknown, path: string): JsonLeaf {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  throw new Error(
    `A ${typeof value} sits at ${path === "" ? "(root)" : path}. JSON cannot express it, so this is a live object rather than what a client receives — round-trip it through JSON first.`,
  );
}
