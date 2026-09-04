---
"@pithy-sh/matchmaking": patch
---

Matchmaking's config loads outside workerd.

`@pithy-sh/matchmaking/src/index` re-exported both Durable Object classes, so the entry point an adopter's `pithy.config.ts` imports dragged `cloudflare:workers` in and threw everywhere but workerd — the defect `@pithy-sh/multiplayer` shipped as #172, here a second time (#180). Nothing broke in the field only because matchmaking is not in the CLI's catalog yet; it would have broken on the commit that added it.

The factory and the Durable Objects are two things with two runtimes, and they are now two entry points. `matchmaking()` and its config come from `@pithy-sh/matchmaking/src/index`; the classes come from `@pithy-sh/matchmaking/src/queue/durableObject` and `@pithy-sh/matchmaking/src/presence/durableObject`, which is what the README now tells adopters to export from their worker. A worker that re-exported them from `src/index` re-points those two lines at the deep paths.

The presence header and event types are no longer re-exported from the presence Durable Object either. They live in the pure `presence/protocol` and are imported from there by everyone, DO included — a value import out of a `cloudflare:workers` module is precisely how #172 reached multiplayer's config path.

The invariant is a gate, not a fixed bug: the package's entry point is imported in its own Node process and required to resolve. It names no forbidden module — it performs the import. `configEntrypoints.test.ts` states the same invariant across the catalog, and this one stands until matchmaking is cataloged and comes under it.
