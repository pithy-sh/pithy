---
"@pithy-sh/multiplayer": patch
"@pithy-sh/cli": patch
---

Multiplayer's config loads outside workerd, and every capability's entry point is held to it.

`@pithy-sh/multiplayer/src/index` re-exported the `MultiplayerSession` Durable Object, and the routes imported two constants out of that same module — so the entry point an adopter's `pithy.config.ts` imports dragged `cloudflare:workers` in and threw everywhere but workerd. `pithy upgrade --dry-run` on any project composing multiplayer died with "Could not load pithy.config.ts", naming the wrong cause (#172).

The factory and the Durable Object are two things with two runtimes, and they are now two entry points. `multiplayer()` and its config come from `@pithy-sh/multiplayer/src/index`; the class comes from `@pithy-sh/multiplayer/src/session/durableObject`, which is where the manifest's scaffold step already told adopters to export it from. The header and RPC sentinel both sides share moved to a pure `session/protocol` module. A worker that re-exported the class from `src/index` re-points that one line at the deep path.

The invariant is a gate, not a fixed bug: `configEntrypoints.test.ts` imports every cataloged capability's entry point in its own Node process and requires it to resolve. It names no forbidden module — it performs the import — so the next entry point that reaches for a runtime-only one fails in CI rather than in an adopter's CLI.
