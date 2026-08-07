---
"@pithy-sh/cli": patch
---

The two seed writers go through the atomic write, and the exemption list is empty.

`writeSeedArtifact` puts the **live dev-login session cookie** on disk. It used a plain `writeFile`: the
file landed at whatever the umask allowed — world-readable on a default one — and a foreign-owned symlink
at `logs/dev-login.json` carried it out of the project entirely. It is written owner-only now, through the
primitive that owns the link-ownership rule; a file already there keeps the mode the adopter gave it.

`seed/media.ts` rolled its own temp-file-plus-rename for the asset-id sidecar: no exclusive create, no
ownership check, no mode, no sweep of what a killed run leaves. The payload changes what that costs, not
whether it is the same shape.

`seed/media.ts` was on the rename gate's list with a note saying to route it and delete the line. That is
this. Nothing is exempted now because nobody got to it yet — every entry left names a rename that is a
rename.
