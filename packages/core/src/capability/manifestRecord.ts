// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The one key a parsed object loses on the way through a schema, and the guard that refuses it.
 *
 * A manifest is JSON read out of `node_modules`, written by a capability author and parsed by a client.
 * `JSON.parse` gives `__proto__` an own property, because it must — the alternative is a manifest that
 * can set the prototype of every object a client builds. Zod then skips that key while projecting the
 * record, for exactly the same reason: assigning it onto the `{}` it builds into would run the setter on
 * `Object.prototype` instead of creating a property. Neither decision is wrong. Together they mean a key
 * enters the parse, matches no rule, raises no issue, and is not in the result.
 *
 * That is the shape worth naming: **not a value rewritten, a key that was never reported at all.** The
 * key schema on `needs` would have refused `__proto__` on its first character; it never ran, because the
 * skip happens before the key type does. So this does not add a rule. It gets the rule that is already
 * written back in front of the data.
 *
 * **Refuse, not degrade.** The surrounding design degrades an unrecognised *issuer* to `other` so a
 * client built today can read a manifest written tomorrow, and that is right for a value. It is wrong
 * here twice over. `__proto__` is not a name a future issuer will be called; it is a mistake or an
 * attack. And degrading a key is a merge — the defect the issuer-key rule was written to close, where
 * two unknown keys rewritten to one overwrite each other's requirements in silence. Refusing is the only
 * answer that leaves nothing to detect after the fact: a manifest that will not parse is reported by
 * every client that reads it, and `pithy doctor` already names the package that shipped it.
 *
 * Applied at the schema, not at a call site, because the exposure belongs to the *shape* — any record a
 * manifest may state has it — and a rule that lives at one call site is how this codebase has repeatedly
 * fixed one field and left its siblings. `manifestRecord.test.ts` walks `CapabilityManifest` and attacks
 * every record it finds, so a record added later without this guard fails on the commit that adds it.
 */
const UNREPRESENTABLE_KEY = "__proto__";

/**
 * Whether a value states no key that would vanish during parsing.
 *
 * Non-objects pass: they hold no keys, and the record schema behind this guard is what refuses them for
 * being the wrong type. `Object.hasOwn` and not `in`, because every object inherits `__proto__` and only
 * an own one is data somebody wrote.
 */
function statesNoUnrepresentableKey(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return !Object.hasOwn(value, UNREPRESENTABLE_KEY);
}

/**
 * A record a manifest may state, held to keys that survive being read.
 *
 * Wraps rather than replaces: the record keeps its own key and value schemas, and this only guarantees
 * they are given every key the manifest wrote. See {@link UNREPRESENTABLE_KEY} for why that is not
 * already true.
 */
export function manifestRecord<Schema extends z.ZodType>(
  record: Schema,
): z.ZodPipe<z.ZodCustom<unknown, unknown>, Schema> {
  return z
    .custom<unknown>(statesNoUnrepresentableKey, {
      error: `A manifest record may not state a "${UNREPRESENTABLE_KEY}" key. It is the one name a parsed object loses without a word, so whatever it keyed would be gone with it.`,
    })
    .pipe(record);
}
