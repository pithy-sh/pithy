---
"@pithy-sh/ui-react": patch
---

A seeded file ships with the gate that notices when it breaks, and adding one without deciding is now red.

> **Every seeded file whose invariant an adopter can break silently ships with the gate that notices.**

`pithy ui add react --auth --payments` seeded eighteen files and no test at all, while ten gates over those same files sat in `packages/ui-react/src/` — each stated over the pristine template text, so every one went silent at the exact moment the files became the adopter's, which is the same moment they stopped being fixable from here. #383, #392, #393 and #394 each fixed one instance. This is the rule they were worked examples of, written where a template author meets it.

`docs/CONVENTIONS.md` § *Seeded files* is the statement: the three properties a seeded gate must meet — the failure is silent, the expectation is a canary rather than the real value, and it is proven able to fail in a scaffolded project — plus the questions that decide whether to write one at all. `packages/ui-react/src/templates.ts` carries the short form, because adding a template means editing that file.

**Three clauses the instances earned, and none of the three properties needed changing.**

*Who can break it?* When the party that can is the kit rather than the adopter, the gate stays in the kit; `client-env.d.ts` is held that way, because a gate seeded into somebody's repository would go red about a contract they never moved.

*Can the gate run where it would be seeded?* A wall you find by trying. The palette invariant lives in CSS text, and **Vitest stubs CSS modules to the empty string** — `?raw` and a raw glob both answer `""` under the plain `vitest run` an adopter has. A seeded gate would have swept an empty set and passed, which is worse than no gate because it reads as coverage. It is kept in `packages/ui-react/src/palette.test.ts`, and the ledger records the wall and what is lost.

*Can you remove the invariant instead?* Gating is the second answer — and then seed the gate anyway, because a removal is itself an invariant and just as silently reversible by the next editor.

`packages/ui-react/src/seededGates.test.ts` carries the ledger: every seeded file, and one of three answers — the gate seeded beside it, the gate the kit kept and why it could not travel, or no gate and why none is owed. A path added to `TEMPLATE_GROUPS` is red until that line exists. It is a forcing function, not a detector, and it says so: nothing static can tell whether a file *has* an invariant. What it can do is refuse to let the answer rot, and check the one property that mechanises.

**`--danger` was a real half-set, shipped.** `pithy-screens.css` read it, `docs/UI.md` and both stylesheets' docblocks named it one of the seven, and `styles.css` declared it nowhere — so Pithy's error red sat on the adopter's background. Fixed, in both colour schemes, and `palette.test.ts` now derives both sides from the files rather than listing either.

`CHECKOUT_FRAME` is one statement in `src/payments.tsx` rather than a copy in each screen that sells. `.pithy-checkout` is an adopter hook with no rule anywhere on purpose, and that is now written down rather than merely true.
