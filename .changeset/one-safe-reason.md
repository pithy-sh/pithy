---
"@pithy-sh/core": patch
"@pithy-sh/cli": patch
"@pithy-sh/vite": patch
---

One filter decides what a runtime's error may say to an adopter (#228).

`safeReason` is the control that stops a parser diagnostic — a multi-line ANSI box quoting an absolute path and the adopter's own source line — from landing in a `PithyError`'s `action`, which the CLI renderer prints and the HTTP codec does not strip. It existed three times, near-verbatim: `project/config.ts`, `capabilities/loadFailure.ts`, and the vite plugin's `workerConfig.ts`, each with its own `ABSOLUTE_PATH`, its own ANSI regex, and its own copy of the tests around them.

A security control in triplicate is one fix away from being a security control in duplicate, and that already happened once. #223 found that testing *content* let Bun's build-failure wrapper through — `2 errors building "app/config:12:5.ts"` carries no leading slash, so it passed the absolute-path check and dragged a fabricated `Line 12, column 5` out of the file name with it — and closing it meant editing three files correctly, by someone who knew all three were there.

#223 moved `rootCause`, `prop` and `isBuildFailureWrapper` into core as recorded facts about a runtime and deliberately left the rest, on the reading that what a surface may say is that surface's business. That is true of the sentences and false of the filter. Whether a string carries a path, a stack frame or half an ANSI box is a property of the string, and three surfaces cannot hold three answers to it without two of them being wrong.

So the filter moved and the policy did not. `safeReason`, `causeMessage`, `failurePosition` and `unresolvedSpecifier` are `@pithy-sh/core`'s, with the provenance suppression written **once** — a build-failure wrapper is refused before a single content test runs, and `failurePosition` refuses the same shape for the same reason, so no position is ever invented out of a file name again. What each classifier recognises as unresolved or unparseable, and what it tells an adopter, stays where it was: the capability loader still holds a bad subpath out of its resolution branch, and the three refusals still say their own three sentences.

`@pithy-sh/vite` still depends on `@pithy-sh/core` and on nothing else in the kit. That constraint is what made core the right home for `rootCause`, and it is what makes it the right home for this.

The invariant is a gate rather than a claim: **no module outside core decides whether a cause's message is safe to show.** `project/config.test.ts` walks every shipped source file in the repository and fails on any module that declares a message-safety filter of its own — a function named for the safety of a reason, or its own absolute-path recogniser, the constant no copy of this managed to do without. Proven by planting a fourth copy in the vite plugin and watching it name the file. De-colouring is not flagged: `dev/logging.ts` strips ANSI to render a log line, and formatting is not a decision about what an adopter may be told.
