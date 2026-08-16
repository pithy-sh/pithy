// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * The compatibility date every Worker in this repository runs on — deployed and under test alike.
 *
 * **A compatibility date is a behaviour contract, not a version number.** It is the date workerd
 * pretends it is: every fix and every semantic change whose default-on date is later than this one is
 * withheld from the Worker, on purpose, so nothing changes under a deploy nobody made. Moving it is
 * therefore not an upgrade. It is adopting a set of behaviour changes, all at once, and the whole cost
 * of a compatibility date is that the set is invisible until something in it matters.
 *
 * **Which is how nine deployed Workers came to sit fifteen months behind (#388).** Every one of them
 * said `2025-01-01`. Not one of them had been argued for — a new capability's `wrangler.jsonc` is
 * written by copying a sibling's, so the first Worker's unconsidered default became the ninth's, and
 * seventeen `vitest.workers.config.ts` files copied it too. That second population is the worse half:
 * a harness pinned older than the Worker it is evidence about is not evidence, and #385 spent a day on
 * a phantom `unhandledrejection` that only the harness could still produce.
 *
 * ## Why this date
 *
 * `2026-03-03` was the floor on offer. It is the date workerd turns on
 * `unhandled_rejection_after_microtask_checkpoint`, which is the one behaviour #385 bisected: a promise
 * returned rather than awaited out of an `async` function fired `unhandledrejection` even where the
 * caller awaited and caught it, and `2026-03-02` reproduces where `2026-03-03` does not.
 *
 * **It was declined, because the minimum that fixes the last bug is exactly the number `2025-01-01`
 * once was.** A date chosen to clear one known defect is a date nobody will revisit until the next
 * defect, and the argument for moving it will be as narrow the second time.
 *
 * `2026-06-01` is chosen instead, and it is not a newer number for its own sake. **It is the date this
 * repository already ships to everybody else.** `pithy init` scaffolds an adopter's Worker at
 * `2026-06-01` (`cli/src/project/workerScaffold.ts`), and `templates/starter` states it too. So the
 * kit's own Workers now run what the kit's users run, and there is one date in this tree rather than
 * two — which matters most where a defect is reported by an adopter and reproduced here.
 *
 * ## Moving it
 *
 * Edit this constant, then run every workers suite. That is the whole procedure, and the second half is
 * not optional: the suites are what turns "the date moved" into "the behaviour was checked". Name any
 * difference in the changeset rather than leaving it to be discovered.
 *
 * ## Where it is repeated, and why that is safe
 *
 * The seventeen `vitest.workers.config.ts` files under `packages/` import this. The ten `wrangler.jsonc`
 * files cannot — JSONC has no imports — so each states the literal with a comment pointing here.
 * `templates/starter` states it in both, and that exception is structural rather than an oversight: that
 * tree is copied into an adopter's repository, where this file does not exist to import.
 *
 * **A copy is a second place for a number to be right, so it is gated rather than trusted.**
 * `packages/cli/src/ci/compatibilityDates.test.ts` reads every `wrangler.jsonc` in the tree and fails
 * on any date older than this one, and fails on a workers config that writes a date instead of
 * importing this. A tenth Worker copied from a ninth cannot start at `2025-01-01` again without the
 * build going red in front of whoever copied it.
 */
export const COMPATIBILITY_DATE = "2026-06-01";
