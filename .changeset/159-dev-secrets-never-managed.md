---
"@pithy-sh/cli": patch
---

Dev secrets cannot reach a managed environment, whatever the caller asks.

`.dev.secrets.jsonc` holds minted random dev values. Seeding it into staging or production would not
set some secrets — it would rotate every one at once: every session invalidated, every signed link
broken, every OAuth credential replaced with a value the provider has never seen, and no undo, because
the values it overwrote were the only copies.

The rule was a conditional in one caller out of six. It is now in the seeder. No signature in the
dev-secrets path accepts an environment — `env` is typed `never`, so a caller that tries to pass one
does not compile — and the seeder asserts the destination rather than the intent: the store must be
the project's own local Miniflare-backed dev store, by the path it persists to. A store that will not
say where it writes is refused too. Permissive-by-default was the bug.
