---
"@pithy-sh/leaderboard": patch
"@pithy-sh/payments": patch
"@pithy-sh/secrets": patch
"@pithy-sh/storage": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
"@pithy-sh/vector": patch
"@pithy-sh/email": patch
"@pithy-sh/media": patch
---

Every Worker this kit deploys now runs the compatibility date its adopters run.

Nine of them were pinned at `2025-01-01` — the leaderboard rank pass, the secrets manager, and the email, media, payments, storage, support, testers and vector Workflow hosts. Fifteen months of workerd behind them, and not one of it chosen: a new capability's `wrangler.jsonc` is written by copying a sibling's, so the first Worker's unconsidered default reached the ninth. Seventeen `vitest.workers.config.ts` files had copied it too, which is the worse half — a harness pinned behind the Worker it is evidence about is not evidence, and #385 spent a day on a phantom `unhandledrejection` only the harness could still produce.

**The date is `2026-06-01`, and `2026-03-03` was declined.** `2026-03-03` is the minimum that fixes #385's behavior, and the minimum that fixes the last bug is exactly what `2025-01-01` once was. `2026-06-01` is what `pithy init` already scaffolds and what `templates/starter` already states, so the kit's own Workers run what its users run and this tree holds one date rather than two.

It is stated once, in `compatibility.ts` at the repository root, with the argument beside it. The workers configs import it. The `wrangler.jsonc` files cannot — JSONC has no imports — so each states the literal under a comment pointing there, and `cli/src/ci/compatibilityDates.test.ts` fails on any Worker manifest behind the floor, any workers config that writes a date instead of importing it, any Worker run ahead of the harness that exercises it, and any scaffolder stamping an adopter's first Worker behind the kit. All four were planted and watched go red.

**Nothing changed under the move.** Every workers suite was run before and after: 17 packages, 2,212 tests, the same pass on both sides. The one deliberate difference is `@pithy-sh/auth`, which drops the explicit `unhandled_rejection_after_microtask_checkpoint` #385 added — the date is three months past where workerd turns it on. That removal is the proof the date took effect rather than a tidy-up: with the flag gone and the date set back to `2026-03-02`, the two phantom rejections return.
