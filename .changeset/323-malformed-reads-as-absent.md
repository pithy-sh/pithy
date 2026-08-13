---
"@pithy-sh/core": patch
"@pithy-sh/secrets": patch
"@pithy-sh/cli": patch
---

A malformed secret was reported as absent, and the suggested remedy did nothing.

`No SECRETS_ENCRYPTION_KEYS recorded. Run pithy add secrets.` said "absent" about a key that was there and failed its schema — and the command it named then returned without doing anything, because a key was already present. Three states collapsed into that one sentence: no project name, an unreadable file, and a stated value that will not read. Two investigations died in the third one, and one of them produced a work plan built on a refuted premise.

**The reader no longer swallows what it read.** `statedMasterKey` answers with the value, with nothing, or with the sentence saying why — a type with a slot for each, instead of `string | undefined` and a bare `catch {}`. Nothing new is written: `requireProjectName`, `readDevSecretsSource`, `loadDevSecrets` and `storedSecretValue` each already named the secret, the file and the fix, and the defect was a `catch` throwing four good messages away. "Not recorded" is a claim about the file, and it is now made only when the file makes no claim.

**`pithy doctor` judges what a stated value is, not that it is there.** `Object.hasOwn` was the entire check, so a value violating its own registry schema passed doctor and failed the next seed — the one command whose job that is. It is checked through the seeder's own `storedSecretValue`, so the two cannot come to two answers, reported apart from `missing`, and counted a fault. A file that will not parse now carries the loader's sentence rather than "run pithy seed to see which secret and why", which spent a round trip re-deriving what the run already knew.

**The envelope parser rejects a non-envelope instead of stripping it into one.** `DevSecretEnvelope` accepted any object carrying `currentVersion` and `versions` and dropped the rest — so an `EncryptionConfig`, a structural superset of an envelope, parsed as one, lost `lastRotatedAt`, and left a base64 string where a nested object belongs. The failure then surfaced three frames later talking about version `"1"`. It is strict now, and the error says what was found: which keys, or which type. Keys and types only — the file holds OAuth client secrets.

`sentenceOf` in `@pithy-sh/core` is where the two reporters get their one sentence from — a caught error's message and its `action`, never its `detail`. Both of them had grown a copy of it, and a three-line helper in two files is a helper that drifts.

The format's guarantee is unchanged and is the reason for all three: the outer object is always the envelope. `SECRETS_ENCRYPTION_KEYS` carries a full envelope in the file like every other secret, and its binding carries the bare `EncryptionConfig`. That is `bootstrap`, it is correct, and nothing here alters it.
