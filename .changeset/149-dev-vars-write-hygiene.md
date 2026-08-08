---
"@pithy-sh/cli": patch
---

`.dev.vars` is read honestly, written at 0600, and never widened.

Four faults in the one file that holds the dev master key and every injected session secret.

An unreadable `.dev.vars` read as an absent one: `EACCES`, `EISDIR` and `EIO` all came back as "no
file", so the next write was built from an empty base and renamed over a file full of values the
process never saw. Only `ENOENT` means absent now; anything else is an error naming the path and the
errno, and no line of the file.

`pithy turnstile deprovision` widened the file it wrote. An atomic write is a rename, so the mode
that lands is the temp file's, and `removeDevVars` passed none — deleting one key handed the whole
file back at the umask default.

A file already at 0664 was never tightened, because the only thing that set the mode was a write the
no-op guard correctly skipped. The group and other bits now come off on every run. Narrowing only: a
deliberate 0400 survives.

And a symlink chain that never ends was followed to the bound and then written through, replacing the
link with a private file and reporting the value delivered. It is refused out loud.
