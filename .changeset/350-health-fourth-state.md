---
"@pithy-sh/core": minor
---

Give a capability's health summary a fourth state, so one sick store stops blanking the manifest.

#317 got three states right — nothing declared, withheld for want of a scope, and zero — and left the fourth to a reviewer, on purpose. A producer that throws is none of those, and returning `null` for it would have made a broken store indistinguishable from a number a caller may not see. That reasoning was right. The behaviour was that the throw propagated, `GET /control-plane/manifest` failed whole, and one capability's bad afternoon took every other capability's number with it, with nothing on screen saying which one.

A manifest entry's `health` is now a four-state value: `undeclared`, `withheld`, `reported` with its scalars, and `unavailable`. The state rides **on** the value rather than beside it, so a scalar is unreachable without narrowing on `state` and a consumer that forgets the sick case gets a type error rather than a screen reading zero. A flag next to the numbers would have been the same information and the opposite property.

A producer that throws — or that reports what its own declaration cannot name — now costs that capability's number and nothing else. Every sibling still resolves.

**Nothing from the throw travels.** `unavailable` carries no message, no code and no detail, and the caught error is dropped whole rather than logged: a health producer runs inside a customer's data path, so what it puts in `detail` is a query, a row, or a key id. What survives is that this capability could not say, and its name, which the manifest already carries in public.

The wire keeps two flat fields — `health` and a defaulted `healthUnavailable` — and the schema is a codec between them and the four-state value. A Worker deployed before this sends no flag and lands where it always did, and a client pinned to an older build strips a field it has never heard of and reads silence rather than a zero.

`namedHealthValues` takes the four-state value and names nothing for anything but `reported`. A surface that must say *why* there is no number reads `state`.
