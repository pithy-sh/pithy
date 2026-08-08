---
"@pithy-sh/core": patch
"@pithy-sh/cli": patch
"@pithy-sh/ledger": patch
"@pithy-sh/leaderboard": patch
"@pithy-sh/multiplayer": patch
---

`pithy add` seeds a worked example where an empty one would not load.

Three capabilities still left a project that could not typecheck. `ledger` omitted `currencies`, `multiplayer` omitted `games`, and `leaderboard` omitted `boards` behind a `serverAuthoritative` defaulted to the string `"true"` against a boolean field. All three failed `tsc` on a scaffold the adopter had not touched.

#161's empty literal is the wrong fix here, and that is the whole of this change. Each of the three puts `.min(1)` on its collection with a message saying why — *"A ledger with no currencies does nothing."* An empty seed compiles and then throws `too_small` on the first config load, which `pithy upgrade` reports as "Could not load pithy.config.ts / Install the project's dependencies". That names the wrong cause and is worse than the type error it replaced.

So a manifest default may now be a complete, minimal, working example, and each of the three states one. `ledger` seeds `chips` — one currency, the schema's own first example of a unit that is plainly not money. `leaderboard` seeds an all-time board where the highest score wins: the smallest board that works and the one shape that needs no rank worker. `multiplayer` seeds tic-tac-toe — the built-in `connect-n` model on a 3x3 board, two players, no wagering — the smallest game that actually plays. The comment above each says to replace it. The adopter edits one line instead of inventing a shape from a type error.

`ConfigOptionValue` widens to any JSON value but `null`, stated recursively rather than as `unknown` contents, so a null buried three levels down is now rejected instead of rendered into someone's config file. Rendering is no longer `JSON.stringify`: that quotes every key, and Biome rewrites `{"code":"chips"}` to `{ code: "chips" }` and fails the scaffold's own lint gate. `renderConfigValue` prints the shape Biome would have printed, on one line.

Each of the three capabilities now checks its own manifest against its own factory — the rendered options are type-annotated, so a shape the factory would reject fails the compile, and the factory call is what proves the seed survives the `.min(1)`.

All fifteen addable capabilities now go `pithy init` → `pithy add` → `tsc -b` → `biome check` clean, and fourteen of them load the config they were written into. `multiplayer` is the exception, for an unrelated reason: its entrypoint re-exports the Durable Object, so importing its config outside workerd fails on `cloudflare:workers`. That is its own defect.
