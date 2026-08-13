---
"@pithy-sh/core": patch
---

Refuse a key that vanishes wherever a payload states one, not only in a manifest.

#331 closed `__proto__` on two manifest fields. The exposure was never the field: `JSON.parse` gives the key an own property and Zod skips it while projecting, so it enters a parse, matches no rule, raises no issue, and is not in the result. Any record read from outside this process has that shape. `ClientProjection` did — a capability could write the key into its client projection at any depth, and the bundle came out without it with nothing said.

`refusesVanishingKey` is the guard, `manifestRecord` is now its manifest wording, and both live in `capability/vanishingKey.ts`. The projection is guarded in two places and no more: on `JsonValue`'s record branch, which every object at every depth passes through, and on the projection's own top level, which is an object with a catchall and so is parsed by the object branch instead. The walk in `vanishingKey.test.ts` covers both roots and is what says two is all of them.

`Object.create(null)` does not close this, which #331 left open. Zod compares the key by name and skips it before assigning anything, so no prototype on either side of the parse is consulted — measured, and kept as a test. A guard in front of the schema is the only altitude that works.
