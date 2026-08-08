---
"@pithy-sh/cli": patch
---

`pithy doctor` prints the `Secrets:` line on every run, terse report included.

The line sat inside the block the terse report suppresses, so a healthy project never saw it — while three comments, `docs/CLI.md`, and #156's own acceptance criterion all said it printed always. It is the one line in the report that nothing else can tell you: since #156 the dev secrets file lives outside every checkout, nothing in the project names it, and `ls` will not find it. A report that omits it leaves an adopter with no way to find the file at all, and "where is it" is not a complaint for the terse report to swallow.

It also carries the only rename trail. `devSecretsFile` is deliberately not a term in the terse predicate, so a project whose *only* anomaly is a renamed or duplicated config directory renders terse — and the trail was unreachable in exactly the case it was written for.

The line's content is now built once and rendered twice: padded beside `Config dir:` and `State file:` in the verbose report, and on its own — same position, unpadded, nothing to align against — in the terse one. `docs/CLI.md`'s terse transcript prints it too, still pinned to the renderer by `doctorDocs.test.ts`.
