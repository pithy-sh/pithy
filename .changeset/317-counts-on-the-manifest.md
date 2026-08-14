---
"@pithy-sh/core": minor
"@pithy-sh/secrets": minor
---

Put a capability's numbers on the manifest, so a client stops paying a round trip per count.

A management client that wants to say "3 secrets need rotating" beside a rail had to call again — once per capability it wants a number from, against a customer's production Worker, on every screen load. The count is not the expensive part. The round trip is.

A capability may now contribute a bounded health summary to its own manifest entry, declared alongside its routes with `defineCapabilityHealth`. `@pithy-sh/secrets` contributes one: how many secrets are past the cadence their registry entry declares.

Three rules keep it from becoming a data API, and each is in the type rather than in a comment. **Scalars only** — a value is `number | string`, so a projection, a row, or a collection that grows with an adopter's data does not compile. **A closed vocabulary per capability** — the manifest carries the declarations beside the values, so a client renders a key it has never heard of from what the Worker says about it, and a value the declaration cannot name is refused before it reaches the wire rather than dropped. **Nothing that costs a table scan** — `cost` is `memory` or `indexed` and has no third member, so a value that would need one cannot state its cost and therefore cannot be declared.

A withheld number and a zero are different facts. Each key names a scope the capability's own admin routes already require, checked at assembly — a scope no route requires is one an adopter is never offered at connect, so the number could never be granted, and that composition now refuses to boot. A connection without the scope gets `null` beside a non-empty `healthKeys`, never `0`, and the producer is not run at all.

The seam is branded: only the factory can build a declaration, so nothing reaches a manifest unparsed.
