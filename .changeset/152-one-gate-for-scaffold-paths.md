---
"@pithy-sh/cli": patch
---

One gate decides whether a path is safe to scaffold into, and `pithy ui add`, `pithy worker add`, and
`pithy worker rename` all ask it.

Three more gates followed symlinks. `pithy ui add` wrote six files of the front end outside the project
through a link at `apps/<worker>/src`, exit code 0. `pithy worker add` did the same with a link one level
up at `apps` — the level the previous fix never looked at. `pithy worker rename` cleared its own gate on
a dangling link and died on a raw `node:fs` ENOTDIR, through the error contract `--json` callers parse.

`ensureScaffoldPath` now walks every directory between the project and the target, `lstat`s each one, and
refuses a symlink or a file with an actionable `PithyError`. A test fails the build if a module that writes
to the filesystem probes with `access` again.
