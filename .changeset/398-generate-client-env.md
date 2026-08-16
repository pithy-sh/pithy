---
"@pithy-sh/vite": patch
"@pithy-sh/ui-react": patch
---

`client-env.d.ts` is generated from the four declared client projections, so there is one statement of the shape and nothing to keep in step.

`templates/client-env.d.ts` — the ambient declaration `pithy ui add react` copies into an adopter's Worker — was 144 lines written by hand, three packages away from the `client:` projections that produce the values it describes. #392 could not generate it: `Capability.client` was typed `(context) => ClientProjection`, so the only source in reach was one sample's *values*, and a type inferred from a value collapses every union and loses every doc comment. It shipped a `tsc`-based gate instead. #395 annotated the four projections and then measured whether generation had become faithful — mutual assignability, both directions, all four modules — and found one error, one direction, one field.

`@pithy-sh/vite`'s `src/clientEnvDeclaration.ts` now emits the file from `AuthClientProjection`, `PaymentsClientProjection`, `SupportClientProjection` and `TurnstileClientProjection`, at kit build time, and the artifact is committed. The declared type's own source text is copied rather than re-printed from a resolved type, because the doc comments are half of what the file is worth — the sentence telling a screen author to render `action` and never retype it now reaches the adopter with the field.

**One type changed, and it is the field #395 measured.** `paddle.checkout` was `string` and is now `"overlay" | "inline" | "hosted"` — the declared union, which is what the capability has always projected. A screen that switches on it to decide whether to render a checkout container gets exhaustiveness. Every other difference in the emitted file is a doc comment that was not there before, or a one-line object type that is multi-line now because it carries them.

Three things are written as fixed text rather than derived, because they are policy and not shape: the `/// <reference types="vite/client" />` preamble, the prose explaining why each default export is a union, and `export const enabled: boolean` as the **only** named export — a named import of any other key must fail the build on the absent-capability case, and deriving the named exports from a projection's keys would take that refusal away.

**No adopter build step.** The kit generates and commits; `pithy ui add react` still writes one static `.d.ts` and a scaffolded project typechecks with nothing new to run.
