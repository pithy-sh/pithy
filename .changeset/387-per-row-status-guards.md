---
"@pithy-sh/secrets": patch
---

A malformed row in `admin/status` costs its own name, not the read.

Three batch reads decoded rows in bare loops, so one row that would not decode threw out of the whole
read. `#387` named two; the third — the `lastRotatedAt` decode in `rotationFacts` — was found by asking
the issue's closing question.

- `storedFacts` decoded `createdAt` and `updatedAt` per row inside the chunk loop.
- `rotationFacts` decoded the `max(case when …)` aggregate the same way.
- `readSecretRotations` ended `rows.map((row) => SecretRotationRecord.parse(row))`, so one bad row emptied
  a whole secret's history.

Each row's outcome now rides on its value, so a caller cannot reach the facts without narrowing.
`readSecretStatus` answers `SecretStatusEntry[]` and `readSecretRotations` answers
`SecretRotationEntry[]`. Absent stays outside the union: a name with no row is still a readable status
whose nulls say so, which keeps *missing* and *malformed* separate before either becomes an error.

Every guard's `catch` takes no binding, so nothing derived from a decode failure can travel — these rows
sit beside `error_message` and `metadata_snapshot`.

`secretsHealth` reports a number when one row is bad rather than the capability reporting `unavailable`.
`#350` made that blast radius survivable; it did not make the read correct, and the manifest could not say
which row was the problem. `GET {base}/admin/status` gains an `unreadable` array of registry names, and
`GET {base}/admin/status/:name/rotations` an `unreadable` count.

`readSecretStatus`'s own `SecretStatus.parse` is deliberately left unguarded: it runs over registry
declarations `defineSecretRegistry` already refused at define time, so a throw there is an author error,
not a bad row.
