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
 * That is the defect above, restated. So {@link unpublishedIn} refuses the document instead: a value the
 * caller hands it must be an array, a plain object, or a JSON leaf, and anything else means a live
 * JavaScript object rather than what a client receives. Round-trip through
 * `JSON.parse(JSON.stringify(...))` first: that is what crosses, and what crosses is what a gate is about.
 *
 * **The rule is what the walk can *see*, not a list of types it distrusts.** `typeof` answers "object"
 * for a `Date`, a `Map`, a `Set` and every class instance, and each of those descends to no keys and no
 * leaves — a `Map`'s entries are not own properties and a getter lives on the prototype — so the descent
 * itself was handing out the same exemption through the one branch that looked safe. So a container is
 * one whose whole contents `Object.entries` returns: prototype `Object.prototype`, `Array.prototype`, or
 * `null`. The first two are what `JSON.parse` produces and the third holds nothing anywhere else to
 * find. Naming the unnameable types instead would be the enumeration this module exists to refuse, and
 * the next class nobody thought of would walk straight through.
 *
 * **And `Object.entries` is then what descends, arrays included.** The rule above was stated once and only
 * half run: the array branch still walked by position, so an own property on a plain array — a prototype
 * this walk accepts, nothing to refuse — was contents the walk could not see. A rule the code disagrees
 * with is a rule in a comment.
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

/**
 * Every leaf in a JSON document, wherever it sits, of every JSON type. Object keys are collected separately.
 *
 * @throws If `document` holds a value JSON cannot express, on the same terms as {@link unpublishedIn} —
 * a caller builds its declaration from this, and a value walked to nothing becomes a permitted set that
 * omits a field.
 */
export function leavesIn(document: unknown): JsonLeaf[] {
  return collectLeaves(document, "");
}

/**
 * Every object key in a JSON document, wherever it sits.
 *
 * @throws If `document` holds a value JSON cannot express, on the same terms as {@link unpublishedIn}.
 */
export function keysIn(document: unknown): string[] {
  return collectKeys(document, "");
}

function collectLeaves(value: unknown, path: string): JsonLeaf[] {
  const inside = descend(value, path);
  if (inside === undefined) return [asLeaf(value, path)];
  return inside.flatMap(({ nested, here }) => collectLeaves(nested, here));
}

function collectKeys(value: unknown, path: string): string[] {
  const inside = descend(value, path);
  if (inside === undefined) return [];
  return inside.flatMap(({ key, nested, here }) => (key === undefined ? [] : [key]).concat(collectKeys(nested, here)));
}

function walk(
  value: unknown,
  path: string,
  leaves: ReadonlySet<JsonLeaf>,
  keys: ReadonlySet<string>,
  found: string[],
): void {
  const inside = descend(value, path);
  if (inside === undefined) {
    const leaf = asLeaf(value, path);
    if (!leaves.has(leaf)) found.push(`value ${JSON.stringify(leaf)} at ${where(path)}`);
    return;
  }
  for (const { key, nested, here } of inside) {
    if (key !== undefined && !keys.has(key)) found.push(`key ${JSON.stringify(key)} at ${here}`);
    walk(nested, here, leaves, keys, found);
  }
}

/** One step into a container: the object key if it has one, the value there, and the path to say where. */
interface Step {
  /** The object key, or `undefined` for an array element, which is a position rather than a name. */
  readonly key: string | undefined;
  readonly nested: unknown;
  readonly here: string;
}

/**
 * The contents of a container, or `undefined` for a leaf — and a refusal for anything else.
 *
 * This is the single place the walk decides what it can see, so the gate, {@link leavesIn} and
 * {@link keysIn} all descend on identical terms. A value is a container only if its prototype is one
 * `JSON.parse` produces; a `Date`, a `Map`, a `Set` or a class instance answers `"object"` to `typeof`
 * and yields nothing to `Object.entries`, and treating that as an empty container is the exemption this
 * module exists to refuse.
 *
 * So **`Object.entries` is what descends, arrays included**. An array walked by `value.map` is walked by
 * position, and a position is not the whole of what an array holds: `rows.cursor = "…"` is an own property
 * on a prototype this walk accepts, and the index walk went straight past it. The rule the module states and
 * the code it runs have to be the same rule, or the exemption comes back through whichever branch still
 * disagrees. An index key stays a position — reported as `[0]`, never as a key a caller must permit — and
 * every other own key is a key.
 */
function descend(value: unknown, path: string): Step[] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) refuse(value, path);
  const array = Array.isArray(value);
  return Object.entries(value).map(([key, nested]) =>
    array && isIndex(key)
      ? { key: undefined, nested, here: `${path}[${key}]` }
      : { key, nested, here: path === "" ? key : `${path}.${key}` },
  );
}

/** Whether an own key of an array is one of its positions — the canonical decimal form `Object.entries` gives. */
function isIndex(key: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(key);
}

/** Narrow to a JSON leaf, or refuse the document. A type this walk cannot name is not a type it may skip. */
function asLeaf(value: unknown, path: string): JsonLeaf {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return refuse(value, path);
}

function refuse(value: unknown, path: string): never {
  throw new Error(
    `A ${nameOf(value)} sits at ${where(path)}. JSON cannot express it, so this is a live object rather than what a client receives — round-trip it through JSON first.`,
  );
}

/** What to call the thing in the refusal — its class where it has one, so the message names what was found. */
function nameOf(value: unknown): string {
  if (value === null || typeof value !== "object") return typeof value;
  const named: unknown = (value as { constructor?: unknown }).constructor;
  if (typeof named === "function" && named.name !== "") return named.name;
  return "object";
}

function where(path: string): string {
  return path === "" ? "(root)" : path;
}
