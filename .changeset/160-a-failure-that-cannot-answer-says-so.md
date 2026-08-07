---
"@pithy-sh/cli": patch
---

A failure that cannot answer says so, dev secrets stop at dev, and a credential file is never rewritten unread.

A failed delete told the adopter the opposite of the truth. `survivorsOf` read "the scan threw" as "the target is gone", and an unreadable directory fails the `rm` and fails the scan for the same reason — so the one case where the whole tree survived printed "Nothing of it is left." Reproduced with the real CLI: `pithy worker remove extra` against a `-wx` directory, six files still on disk. There are three states now, and only one of them is nothing: `pithy worker remove` says "Pithy could not read it back, so what is left of it is unknown. Check it." when it cannot tell, and still lists the survivors when it can. Both errnos stay in `detail`, where the codec strips them.

`devSecretReader` read the project's `.dev.vars` in every environment. `.dev.vars` sits on the operator's disk under every `--env`, so `pithy seed --env prod` handed a prepared set a live local dev secret and wrote it into production rows. #159's rule is absolute and the adopter cannot opt out, so it lives in the reader: outside `dev` the reading closure is never built, the file is never opened, and a set that asks is refused by name. Provably dev, not merely not-prod — an unknown or misspelled environment refuses too, because the permissive default is the whole bug.

And `upsertDevVars` destroyed the file it could not read. Every read failure was treated as an empty file, and the atomic write then landed a `.dev.vars` holding only the keys being upserted — every other secret gone, with no copy anywhere because the file is gitignored. `EACCES` on a file that plainly exists is enough; no attacker is involved. Only `ENOENT` means absent now, for `removeDevVars` too, which had the same shape and the quieter failure: it returned early and its caller printed success while the credential sat in the file untouched.

Refs #159, #160.
