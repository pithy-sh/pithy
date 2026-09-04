---
---

A package that never ran no longer reads as a package that passed.

`turbo` cancels every remaining task when one fails. With a package that fails intermittently, that turns a run into a trap: the output names the familiar flake and says nothing about the packages that were canceled behind it. During the Paddle wave a run reported only the known `@pithy-sh/storage` timeout while `@pithy-sh/payments:test` — 6,415 insertions of that wave's work — never started. Reproduced before changing anything: one planted failing test made `bun run test` print `Tasks: 0 successful, 22 total` with a single package named. Twenty-one produced no result and none of them was named.

Every root script whose output is read as a verdict now passes `--continue`: `always` for `test`, `test:node`, `test:workers`, `test:integration` and `typecheck`, which declare no dependencies, and `dependencies-successful` for `build`, which does — a package cannot be built on a broken upstream, and burying the one real failure under derived ones is not an improvement. The reason is recorded in `turbo.jsonc`, since `package.json` cannot hold a comment.

The two `@pithy-sh/storage` tests that made this reachable were measured rather than adjusted. `sweep.workers.test.ts`'s chunking test is genuinely slow — 3.3–3.8s idle against a 5000ms default, and parallelising its 150-object fixture made it *slower*, 5.4–6.2s, so the serial loop stays. `routes.workers.test.ts`'s settlement race is not slow at all — 0.7–0.8s idle, 2.2s with the rest of the repository running beside it. Different diagnoses, both now stated at the test with the numbers they were derived from.
