---
"@pithy-sh/matchmaking": patch
"@pithy-sh/rating": patch
"@pithy-sh/cli": patch
---

`pithy add matchmaking` and `pithy add rating` work. Both packages were complete — routes, migrations,
seeds, workers tests, stamped versions, every repo-wide gate green — and neither shipped a
`pithy.manifest.json`, which is the file `pithy add` reads for the bindings to write and the config to
scaffold. So both refused, and refused in the way that costs most: the action line named the command that
had just installed the package. Both ship a manifest and a catalog entry now, so both appear in
`pithy add --list` and wire themselves.

That matters most for matchmaking, whose two Durable Objects — `MatchmakingQueue` and
`MatchmakingPresence` — have no supported path into a working `wrangler.jsonc` without one. Adding it
writes both namespaces across every environment plus their `new_sqlite_classes` class-migration tag.

**A second Durable Object capability now gets its own migration tag.** Every DO class used to merge into
`v1`, which was correct while multiplayer was the only capability shipping one. Cloudflare remembers the
last tag it applied and the next deploy sends only the tags after it, so appending a class into a tag that
had already been deployed sent it to nobody: the namespace was never created and the deploy failed on a
binding to a class with no migration behind it. `pithy add multiplayer` → `pithy deploy` →
`pithy add matchmaking` is the path matchmaking's own README recommends, and it is the one that broke.
Tags are now allocated per add and never edited after they are written, which costs a never-deployed
Worker nothing.

A package that is installed and ships no manifest is also its own refusal now, separate from a name that
was never installed — same `core/not_found` code, but it no longer tells you to run the command you just
ran. `capabilities/addable.test.ts` is the repo-wide gate that fails on the next capability package
shipping no manifest or no catalog entry; it keys on `src/capability.ts`, because the manifest is the
artifact that goes missing.

Both READMEs are rewritten to the standard the other capabilities keep — starting at `pithy add`, naming
their bindings, migrations, tables, and routes — and matchmaking ships a `docs/costs.md`.
