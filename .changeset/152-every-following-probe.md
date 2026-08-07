---
"@pithy-sh/cli": patch
---

The gate that was meant to stop a fifth symlink escape banned two probes out of five, and missed it.

`stat`, `statSync` and `existsSync` follow a symlink exactly as completely as `access` does. The test
added with the last fix banned only `access` and `accessSync`, so it was green on `capabilities/eject.ts`
— which asked with `stat`, and was the fifth producer. The tripwire had the blind spot of the sweep that
missed the bug.

The rule is the whole class now, and it names every writing module in the package. Two were unrouted.
`pithy add <cap> --eject` copied a capability's entire source through a link at `apps/<worker>/capabilities`
and printed "Done." — reproduced. `pithy ui add react --worker board` wrote ten files of a React front end
outside the project through a link at `apps`, because `scaffoldFiles` bounded the walk at the worker and
put `apps` and `apps/<worker>` above it; the walk starts at the project root now. Five other modules follow
a link on purpose — a mode, an mtime, a `node_modules` path a package manager linked — and each says so in
one line the test holds it to. An unlisted follower fails the build; so does a listed one that stopped.
