---
"@pithy-sh/cli": patch
---

`pithy add`, `pithy remove`, `pithy worker add` and `pithy feature create` say when they are installing.

Each ran its package manager captured and silent. A cold `bun add` or `<pm> install` is minutes with nothing on
the terminal, which reads as a hang. Every package-manager run now goes through one primitive that names the
command line before the child starts: `▸ Running bun add @pithy-sh/auth...`, `▸ Running bun remove …`,
`▸ Running bun install...`. `pithy add --eject` names the install that promotes a fork's dependencies the same
way. `--json` prints none of it and still writes exactly one line. A missing TTY prints all of it.

The narration gate claimed every captured subprocess and looked for `runWrangler(` by name, so it saw none of
these. It now finds children through `child_process` itself — however the binding is imported, aliased,
namespaced, destructured or `promisify`'d — and follows every declaration that reaches one to a step. What it
cannot follow fails the build. What it does not see is written in `ci/narration.test.ts`.
