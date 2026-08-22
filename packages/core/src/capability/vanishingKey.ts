// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The one key a parsed object loses on the way through a schema, and the guard that refuses it.
 *
 * `JSON.parse` gives `__proto__` an own property, because it must — the alternative is JSON that can set
 * the prototype of every object built from it. Zod then skips that key while projecting an object or a
 * record, for exactly the same reason: assigning it onto the `{}` it builds into would run the setter on
 * `Object.prototype` instead of creating a property. Neither decision is wrong. Together they mean a key
 * enters the parse, matches no rule, raises no issue, and is not in the result.
 *
 * That is the shape worth naming: **not a value rewritten, a key that was never reported at all.** A key
 * schema would have refused `__proto__` on its first character; it never runs, because the skip happens
 * before the key type does. So this does not add a rule. It gets the rule that is already written back in
 * front of the data.
 *
 * **`Object.create(null)` does not close this, and #331 left that question open.** The idea is sound on
 * its face — a null-prototype target has no `__proto__` setter to run, so the assignment would create a
 * property and the key would survive — and it is wrong here for a reason that is worth writing down once.
 * Zod's skip is a literal `key === "__proto__"` comparison made *before* any assignment
 * (`zod/v4/core/schemas` at the object and record branches), so the prototype of the target has no bearing
 * on it, and neither does the prototype of the input: handing `z.record` a value built with
 * `Object.assign(Object.create(null), parsed)` still returns without the key. Measured, not assumed. The
 * class cannot be closed by changing what the object is; it can only be closed in front of the schema,
 * which is what this is.
 *
 * **Refuse, not degrade.** The surrounding design degrades an unrecognized *issuer* to `other` so a client
 * built today can read a manifest written tomorrow, and that is right for a value. It is wrong here twice
 * over. `__proto__` is not a name a future issuer will be called; it is a mistake or an attack. And
 * degrading a key is a merge — the defect the issuer-key rule was written to close, where two unknown keys
 * rewritten to one overwrite each other's requirements in silence. Refusing is the only answer that leaves
 * nothing to detect after the fact: a payload that will not parse is reported by every client that reads
 * it, and `pithy doctor` already names the package that shipped it.
 *
 * Applied at the schema, not at a call site, because the exposure belongs to the *shape* — any record read
 * from outside this process has it — and a rule that lives at one call site is how this codebase has
 * repeatedly fixed one field and left its siblings. `vanishingKey.test.ts` walks each guarded root and
 * attacks every record it finds, so a record added later without this guard fails on the commit that adds
 * it.
 */
const VANISHING_KEY = "__proto__";

/**
 * Whether a value states no key that would vanish during parsing.
 *
 * Non-objects pass: they hold no keys, and the schema behind this guard is what refuses them for being the
 * wrong type. `Object.hasOwn` and not `in`, because every object inherits `__proto__` and only an own one
 * is data somebody wrote.
 */
export function statesNoVanishingKey(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return !Object.hasOwn(value, VANISHING_KEY);
}

/**
 * A schema held to keys that survive being read.
 *
 * Wraps rather than replaces: the schema behind it keeps its own key and value rules, and this only
 * guarantees they are given every key the payload wrote. See {@link VANISHING_KEY} for why that is not
 * already true.
 *
 * `subject` names what wrote the record, because the reader of the error is the person who has to go and
 * change it — a capability author for a manifest, an adopter for a projection.
 *
 * Typed on the wrapped schema's own input rather than on `unknown`, so a guard is transparent to whatever
 * it is composed into. Widening every wrapped schema to `unknown` would make the guard's altitude a
 * typing question — it could only go where nothing downstream needed the input type — and altitude is the
 * one thing about this guard that should be decided on the exposure.
 */
export function refusesVanishingKey<Output, Input>(
  schema: z.ZodType<Output, Input>,
  subject: string,
): z.ZodPipe<z.ZodCustom<Input, Input>, z.ZodType<Output, Input>> {
  return z
    .custom<Input>(statesNoVanishingKey, {
      error: `${subject} may not state a "${VANISHING_KEY}" key. It is the one name a parsed object loses without a word, so whatever it keyed would be gone with it.`,
    })
    .pipe(schema);
}

/**
 * A record a manifest may state. The manifest's wording of {@link refusesVanishingKey}, kept in one place
 * so its two call sites cannot drift into two sentences for one rule.
 */
export function manifestRecord<Output, Input>(
  record: z.ZodType<Output, Input>,
): z.ZodPipe<z.ZodCustom<Input, Input>, z.ZodType<Output, Input>> {
  return refusesVanishingKey(record, "A manifest record");
}
