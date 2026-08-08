---
"@pithy-sh/cli": patch
---

The last two readers throwing node's error at an adopter now say a sentence (#203).

`readRcFile` (`platform/rc.ts`) and `nodeMediaFs.readText` (`seed/media.ts`) rethrew node's own error for
any failure that was not `ENOENT`. An adopter whose `.zshrc` would not open got a bare `EACCES` and a
stack trace, which is the failure this repository's error model exists to prevent — and it got it from
`pithy alias` and `pithy doctor`, the two commands most likely to be run *because* something is already
wrong.

Both go through `readOptionalFile`'s `unreadable` callback now, so both refuse with a `PithyError` naming
the file and what to do about it. The errno stays in `detail`, which the HTTP codec strips; node's error
stays as `cause`; no byte of either file reaches the message, because an rc file is where a developer
keeps `export GITHUB_TOKEN=…` and a media sidecar sits beside credentials of its own.

They were like this deliberately. #197 routed six hand-written `ENOENT` branches under a strict
no-behaviour-change constraint, and `readOptionalFile`'s callback returns a `PithyError` by construction —
so it could not express "rethrow node's error", and these two went through `readFileOutcome` instead. That
was correct for that change and is the follow-up it implied. `readFileOutcome` now has one caller,
`capabilities/manifests.ts`, which needs it for the reason it exists: a read that must answer for fifteen
other packages cannot throw.

`pithy alias` is unchanged on a readable rc file and refuses cleanly on an unreadable one. `pithy doctor`
already failed on an unreadable rc file — it now fails with a sentence instead of a stack.
