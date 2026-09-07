---
"@pithy-sh/core": minor
"@pithy-sh/payments": minor
"@pithy-sh/cli": minor
---

**Organization billing without first declaring user billing.** `payments`' `billingSubject` is required, offers two values, and refused one of them — so the only route to a B2B project's own billing model was `pithy add payments --set billingSubject=user`, a value that is wrong for the project, followed by a hand-edit. The end state was right and both refusals that produced it were right. The path was the bug: an adopter's git history recorded a command naming the mode they did not want, and a regeneration audit had to explain why.

`pithy add payments --set billingSubject=organization` is now taken. It writes the choice, scaffolds `apps/<worker>/src/billing/subject.ts` exporting a `resolveSubject`, imports it, and passes it to `payments(...)`. One line of output says the rest: that file is scaffolded, not written, and this Worker refuses to boot until it answers which organization a caller is acting for.

**The scaffold is a marked absence, never a working stub.** A resolver returning nothing would compose cleanly and then deny every entitlement gate — indistinguishable from a customer who has not paid, with a support ticket from a paying company as the first symptom. So the scaffolded resolver answers nothing and is branded unimplemented, and `@pithy-sh/payments` refuses the Worker's entrypoint while the brand is on it. Composition still accepts it, which is what keeps `pithy migrate`, `deploy`, `doctor` and `upgrade` working in the project the scaffold just landed in — every one of them evaluates that config to learn what the Worker composes. Composing `organization` with **no** resolver at all is refused at composition exactly as before.

`Capability` gains an optional `boot` hook for that distinction. `createBackend` is assembled by tooling as well as by Workers; `createEntrypoint` is only ever called by a Worker's own entry, so `boot` is where a capability refuses a composition that must load and must never serve.

**Re-running writes nothing.** The registration is already there, the import is already bound, and a file at the seam's path is the adopter's whatever it contains — three independent guards, because losing a resolver somebody wrote is worse than the bug this fixes.

A manifest declares this with `choicesNeedingSeam`, naming a seam from `CONFIG_SEAMS` — a closed set in `@pithy-sh/core`, so the identifier, the path and the import specifier that reach the adopter's TypeScript are the kit's and never a package's free text. `choicesNeedingCode` stays for a choice the kit cannot scaffold; a choice states one or the other, never both.
