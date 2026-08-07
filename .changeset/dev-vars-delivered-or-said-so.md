---
"@pithy-sh/cli": patch
---

A dev secret is delivered to the Worker, or the run says it was not.

`writeDevVars` became the one writer so a value could not be quoted wrong or land in a file nothing opens. It still had three ways of not arriving, and all three were silent.

**A feature worktree got nothing.** `pithy feature create` and `pithy worker add` build one shared `.dev.vars` for the whole repo: the worktree root and every worker inside it are symlinks at the main checkout's file. The atomic write renamed a new file over the root's link — cutting the worktree off the shared file — and left every worker pointing at the untouched original. Verified against a real worktree: `pithy feature create`, seed, then `wrangler dev`, and the Worker served the superseded secret while the result read `written: ["auth-session-secret"], shadowed: []`. The write now follows the link to the file it names, and each worker's link is resolved and compared against the file that was written. Same worktree, same command: the Worker serves the new value and the sharing survives.

**A failed `symlink()` was swallowed** and the directory counted as linked regardless — a delivery that did not happen, reported as one. It is now named, with the reason, in `undelivered`, which `pithy dev`, `pithy add` and `pithy seed` all print.

**A refusal is fail-closed.** A value no quoting survives used to leave the superseded line in `.dev.vars` — the only place dev reads until #153 — so the Worker kept signing with the old secret while every report said the value was replaced. The stale line goes with the refusal, and the refusal says so. A Worker that will not start beats one quietly running on a secret nobody thinks is current.

And the encoder's own tests never ran through the writer, so reintroducing the exact truncation left the whole suite green. Every hostile value is now round-tripped through `writeDevVars` and read back out of the file.

The raw `upsertDevVars` — unquoted, at whatever path, delivering to nobody — is deleted. It was the obvious thing the next producer would reach for, and it had no callers left.
