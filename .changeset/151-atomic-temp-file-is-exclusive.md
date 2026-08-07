---
"@pithy-sh/cli": patch
---

An atomic write can no longer be redirected by a file planted at its temp path.

`writeFileAtomic` wrote to `${target}.tmp` and renamed it over the target. The name was fixed, so anyone who could write to the project directory could work it out and put a symlink there first. Every write then went through that link: `.dev.vars` — `CLOUDFLARE_API_TOKEN`, `SECRETS_ENCRYPTION_KEYS`, OAuth client secrets — was written and chmod'd at the planter's chosen path, and the rename afterwards moved the *link* over the target, so every later write followed it too. Nothing to race and nothing in the output to notice: exit 0, `Done.`

The temp file now carries 64 bits of randomness in its name and is created with `O_EXCL`. There is no path to plant at, and anything already at the one chosen fails the open rather than being written through. Two things fell out of the same change. The file is always brand new, so the mode it is created with is the mode it is born with — a leftover from a crashed run used to keep its own permissions through `O_CREAT`, which ignores the mode of a file that already exists. And the failures are `PithyError`s naming the path, not raw `node:fs` errnos: a dangling link into a directory that does not exist used to throw an `ENOENT` straight past the contract `--json` callers parse.

`*.tmp` is gitignored, here and in the starter template. A write interrupted by SIGINT leaves a temp sibling holding the full plaintext, and `.dev.vars.*` only ever covered the one secret file whose name it happened to match.
