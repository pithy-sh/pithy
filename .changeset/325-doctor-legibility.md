---
"@pithy-sh/secrets": patch
"@pithy-sh/cli": patch
---

Three faults the doctor and the store found and did not say.

**`--json` carries every fault the human report prints.** `devSecrets.unreadable` became the loader's sentence rather than a boolean, and the projection passed it through unchanged — so a CI script gating on `unreadable === true` stopped firing and read a broken secrets file as healthy. Silently, because a non-empty string is not `false`, it is merely not `true`. `malformed` and `bootstrapMissing` were not in the payload at all, and `malformed` is the one that flips the verdict. All three are there now, beside a `healthy` boolean computed from the same function the text report draws its fault line from. A consumer gates on one field, and the next fault class added needs no consumer to be updated.

**A file that states a master key which will not read ends the open, whatever an older home holds.** The file's sentence was read only when no key was found anywhere, so a project with a malformed `SECRETS_ENCRYPTION_KEYS` in `secrets.jsonc` and a valid one in an older `.dev.vars` opened under the older key without a word. That is not a lost message: this file is what every Worker's `.dev.vars` is generated from, so the next seed encrypted rows under a key the running Worker is never handed, and the only symptom was a decrypt failure three commands later. "The file will not answer" and "there is no file to ask" are two fields now, and only the first is authoritative — a project with no name has stated nothing, so its older homes are still read.

**A keyspace given a single value is a fault, and doctor says so.** `pithy seed` throws `Secret '<name>' … is a keyspace, not a single value.` on exactly that input; `pithy doctor` skipped every keyed entry before the file was consulted, so the one file the seeder hard-fails on was a file doctor called green. The refusal is one function now, thrown by the seeder and quoted by doctor, so the two cannot come to two wordings of one rule.

The promise that a green report means the next `pithy seed` works is asserted as that implication now, over a corpus of files, rather than one case per fault somebody thought of. A promise checked case by case is only ever as true as the list — which is how a keyspace stayed off it.
