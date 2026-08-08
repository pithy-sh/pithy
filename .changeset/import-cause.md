---
"@pithy-sh/cli": patch
---

A config that will not load names its own cause, instead of guessing one.

A `pithy.config.ts` that would not import produced one sentence whatever went wrong: `Could not load <path>.` plus *"Install the project's dependencies (e.g. bun install), then check the config for errors."* A missing dependency and a stray brace were byte-identical. The real reason — the `SyntaxError`, or the specifier that did not resolve — was captured into `detail`, and the CLI renderer never prints `detail`.

That is worse than silence, because the advice is followed. `bun install` cannot fix a stray brace. The adopter runs it, nothing changes, and the parser's own message was discarded one frame up. #172 was this same defect wearing a different hat: a config that would not load naming the wrong cause, misdiagnosed twice before anyone traced the import edge. It was fixed as a bug in one barrel; it was also a bug in how a config-load failure is reported, and only the first half was fixed.

The failure is now classified, and the `action` chosen from it rather than asserted over it. An unresolved import names the specifier and says to install, which is where `bun install` was always right. A parse error gives the parser's own reason and its position, and says installing will not help. A config that throws while loading says what it threw. A cause that matches none of them gets **no** remedy at all — a wrong action is worse than no action.

The security boundary is unchanged and now tested. `message` stays exactly `Could not load <path>.`, and nothing from the throw site reaches `action` either: the cause's message is used only when the whole of it is one short line with no absolute path and no stack frame, which is what separates `Expected identifier but found "{"` from the multi-line ANSI box that quotes the file and its source. Everything dropped is still in `detail`, where the renderer cannot print it and the HTTP codec strips it.

`classifyConfigLoadFailure` is exported and tested directly, because `bin` runs on Bun and the suite runs on Node. Bun's `ResolveMessage` and `BuildMessage` are not `instanceof Error` — an earlier draft gated on that, passed its whole suite against `Error`-based fixtures, and silently dropped the parser's sentence on the only runtime that ships.
