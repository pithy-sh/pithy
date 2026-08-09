---
"@pithy-sh/cli": patch
---

`pithy feature sync --json` reports one `data` field where it reported `migrated` and `seeded`.

Both came from one boolean — the `--skip-data` flag — so they could never disagree. Every consumer's `if (migrated && !seeded)` was a branch that could never fire and could never be tested, and if the two steps were ever split that dead branch would silently become live with whatever meaning the split invented. One flag, one field.

`migrated` was also already taken. On `pithy upgrade` it means the narrower "the migration step ran", so `feature sync` spending it on "migrated *and* seeded" was itself a shared key with two meanings — the defect #231 is about. It is no longer shared: the CLI's `--json` vocabulary gate records it against `upgrade` alone.

Two facts that can differ was not on offer either. Both steps throw on failure, so any run that reaches the payload ran both or neither.

`feature.create` and `feature.provision` **drop the pair rather than emit a constant.** Neither has a flag that can skip the steps and both steps throw, so a report existing at all was already the proof they ran; `migrated: true, seeded: true` was a constant with the grammar of a fact. If either ever grows a `--skip-data` of its own, `sync`'s `data` is the field to copy — a value that can be `false` is the only kind worth emitting.

`docs/commands/feature.md`'s three `--json` tables say so, held to the code by the gate that fails a payload changed without its page.
