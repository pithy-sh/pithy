---
"@pithy-sh/cli": patch
"@pithy-sh/secrets": patch
---

Six corrections to how `.dev.secrets.jsonc` is read, written, and seeded.

**An unreadable file is not an absent one.** The read answered `{}` for every errno. `ENOENT` is the only one that means "no secrets yet"; an `EACCES` or `EIO` merged into an empty base, and the file's real contents went with the next write. Both the read and the write path now refuse, naming the path and the errno and never a byte of the file.

**A zero-byte file is no secrets.** It hard-failed `pithy add` with exit 1 while the write half of the same module was deciding empty content meant `{}`. One state had two answers.

**Nothing is stored before it is persisted.** A minted value written to D1 before it reached the file was a row nothing explained: the next run found the file still without it, minted a different value, and overwrote the row — for a session secret, every live session invalidated on every `pithy dev`, for as long as the file write kept failing. Minting now happens in one exported place, the file is written, and only what landed is seeded.

**`pithy add` seeds against the config it just wrote.** The run held the module it imported before rewriting `pithy.config.ts`, so the registry it seeded against was the composition from before the add and the secret it had just minted never reached the store. It re-imports past the cache. Under Bun the query busts the cache on a path specifier and not on a `file://` URL — the difference is why this looked fixed and was not.

**A JSONC syntax error carries no cause.** `comment-json`'s `SyntaxError` quotes the source it choked on — the whole file, OAuth client secrets included — and it was attached as `cause`. The line and column are kept; nothing else is.

**`Object.hasOwn`, not `in`.** Four lookups walked the prototype chain: a `currentVersion` of `toString` passed the loader and failed later inside the store, a stale name matching an `Object.prototype` key never reported as undeclared, and a secret so named was silently dropped from a write the caller was told had landed.
