---
"@pithy-sh/secrets": minor
---

Secrets recorded everything about a rotation and let nobody read it.

`pithy_secrets_rotations` has carried when a secret was rotated, whether it succeeded, what triggered it and who did it since `0001_init`, and `pithy_secrets_system_secrets` has carried `createdAt`, `updatedAt`, `keyVersion` and `valueType` beside it. No reader touched either, and the capability declared no `adminRoutes` — so the only way to see any of it was `pithy secrets ls` on an operator's own machine, and an owner could not be told a secret was overdue. **No migration; the schema was right and only the door was missing.**

Two reads, one scope, under `admin/`:

- `GET {base}/admin/status` — every declared secret: `name`, `backend`, `valueType`, `rotatable`, `keyVersion`, `createdAt`, `updatedAt`, `lastRotatedAt`, `rotationCount`, `rotateEveryDays`, `overdue`.
- `GET {base}/admin/status/:name/rotations` — one secret's attempts, newest first: `startedAt`, `completedAt`, `status`, `trigger`, `rotatedBy`.

**`secrets:status:read` is its own scope**, granted separately at connect. The read discloses no value and is sensitive in a different way: which credentials a project holds, which are stale, and which no automation will ever rotate is a map of where to push. An adopter must be able to grant a users pane without also granting that.

## The response type cannot express a value

Not omitted by a projection — **absent from the type**, so widening it is a compile error. Four layers, because each catches what the others cannot: the queries name their columns, so `encrypted_value` and `iv` never reach the Worker's memory; rows are parsed through Zod objects, so a later `selectAll()` still discloses nothing; `SECRET_STATUS_CARRIES_NO_VALUE` and `SECRET_RESPONSES_CARRY_NO_VALUE` fail the typecheck if a banned field appears; and `status.test.ts` asserts the exact field sets, so *any* new field — not only a banned one — has to be argued for by somebody editing a list.

`errorMessage` and `metadataSnapshot` are refused, and they are the interesting ones. Both exist on the table and neither is exposed: they are free text written at a failure site, which is exactly where a value gets pasted by accident. A failed rotation still reports — `status` says `failed`, which is the fact an owner acts on. If a reason is ever wanted it is a code, not the message.

There is no route that reads a value and no scope that could grant one. The reason a secret is encrypted under a key only the customer's Worker holds is that no third party has a path to the plaintext; a route here would be that path, in every deployment, whether or not anybody granted it.

## Never rotated is not zero

`lastRotatedAt: null` means never rotated, and a screen can tell it from rotated long ago. `createdAt: null` means nothing is stored under that name here — which is why `backend` is reported, since a `cf-secrets-store` secret never has a row in this database and its nulls would otherwise be unreadable. `overdue: null` means the question has no answer: no cadence declared, or nothing to measure from. False would have claimed the secret was fine, which is a more comfortable answer than "nobody has said what fine is".

A failed rotation never advances freshness — the aggregate takes the newest *successful* completion, not the newest attempt.

## `rotateEveryDays`, so overdue is a fact rather than a guess

A registry entry may now declare its own rotation cadence. An age is a number; whether that age is late is a policy, and the policy belongs beside the secret — ninety days is unremarkable for a session signing key and a long time for a live payment key. Without it every client picks its own threshold, they disagree, and the one an owner happens to be looking at decides whether they are told.

It is independent of `rotatable`, deliberately. `rotatable` says what automation may do; this says what the organization expects, whoever performs it. A `rotatable: false` third-party key is precisely the case where no tooling will ever help, so refusing the declaration there would silence the secrets that most need saying — and a `rotatable: false` secret reports identically to a `rotatable: true` one in every field.

## What the listing covers

Every **composed** capability's secrets, from the combined registry `compose` already aggregates — auth's signing key, email's link key — not only the ones the adopter typed. Keyed entries are excluded: a keyspace has no single value and its members are per-tenant rows, so listing them would turn a status read into a tenant enumeration. Stored rows no registry entry names are excluded for the same reason, and the whole-store at-rest key rotation's sentinel falls out with them — it is an event about the store, not about a secret. Both routes are audited: nothing changes on a read, so without the trail a credential enumerating somebody's secret estate leaves no trace anywhere.
