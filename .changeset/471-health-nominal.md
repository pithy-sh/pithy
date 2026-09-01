---
"@pithy-sh/core": minor
---

A management client can now tell a good number from a bad one.

A health key declared what a value *means* — `key`, `kind`, `states`, `scope`, `cost`, `summary` — and never what it *should be*. `secretsDueForRotation: 0` is the good answer; a `verifiedSenders: 0` would be a fault; the two declarations are identical in every field. So a client holding the number, the scope and an English sentence could render it and nothing more. `pithy-sh/dashboard` shipped that section under a heading reading **Health**, with the good answer presented as a finding, and then removed it — the vocabulary could not support the verdict the heading claimed.

`HealthSummaryKey.nominal` is that claim: `{ atMost }` / `{ atLeast }` for a count, the nominal members for a state, and `null` — the default — where the capability grades nothing. `standingOf(key, value)` answers `nominal`, `attention`, or **`unknowable`**, and `healthAttention(descriptor)` is the values wanting somebody's attention, in declaration order.

**`unknowable` is never `nominal`, and that is the whole design rather than a detail of it.** A key that declares no bound is a key nobody can grade; answering `nominal` there would let a client read healthy because nothing told it otherwise — which is this defect relocated one level up rather than removed. It is `#350`'s choice one layer down: that made the four report states a discriminated union so a consumer forgetting the sick case got a type error instead of a screen that lies. A value whose *type* contradicts its `kind` is `unknowable` too — `checked()` runs on the producing side, and a client parses manifests from Workers it does not control. A `state` value outside its own declared list is not that case: it is still a string, so it is graded, and it is `attention` — a Worker reporting something it never said it would send is not a thing about which nothing can be concluded.

Nothing has to declare one. `nominal` defaults to `null`, so every manifest built before this parses unchanged and every value on it stands at `unknowable` — bit-for-bit today's behavior. A newer Worker reaching an older client is stripped by a non-strict object, as `healthKeys` already relies on. No capability gains a declaration here: whether `@pithy-sh/secrets` claims `{ atMost: 0 }` is that capability's decision, not this change's.

The shape of `nominal` is decided by `kind` and refused both ways — an array on a count and a bound on a state each throw — because a refine written for one direction admits the other. A count's bound must bound something and be satisfiable; a state's nominal must name members that key declares, or the claim is one no producer could ever match.
