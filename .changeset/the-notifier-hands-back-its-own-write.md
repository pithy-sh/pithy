---
"@pithy-sh/cli": patch
---

`runUpdateNotifier` hands back its own completion, so the work it starts can be waited for.

It returned `void`. The only thing a caller could observe was the registry fetch — the job's *first* side effect — while its last durable step is the state write that follows: `writeState` → `writeFileAtomic`, which creates `state.json.<hex>.tmp` beside the target and renames it. `notify.test.ts` waited on the fetch and returned, and its own teardown then removed the directory the write was still working in. `rm(dir, { recursive: true, force: true })` does readdir, unlink, rmdir, and a temp file created after that readdir snapshot fails the rmdir with `ENOTEMPTY` — which `force` does not swallow, because `force` swallows `ENOENT`. Fifteen of fifteen passed idle; one in twenty-five failed under load, and one of those stopped the first attempt at the 0.11.0 release in the gates. A test that fails a release at random is worse than a test that fails.

The promise resolves when the job is over, succeeded or thrown, and never rejects — so `bin.ts` still drops it and the notifier is still fire-and-forget, scheduled through `setImmediate`, silent on every failure, and incapable of delaying a command. Nothing about what an adopter sees changes. What changes is that the write is now something a caller can wait for, and the test waits for it rather than for the first thing it could see.

It does not make an abrupt exit safe and is not meant to. A `.tmp` left in the config directory by a signal, an OOM kill or a `process.exit` is what `writeFileAtomic`'s stale-sibling sweep is for; a promise nobody can await is not.
