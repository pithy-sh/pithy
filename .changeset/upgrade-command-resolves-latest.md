---
"@pithy-sh/cli": patch
---

The upgrade command the notifier prints now resolves the registry's `latest` tag.

`bun update`, `pnpm update` and `yarn global upgrade` each honor the version range an earlier global install
recorded — and for a `0.x` release a caret pins the minor, so `^0.5.0` could never reach `0.7.1`. The command
ran, reported success, installed nothing, and the notice came back on the next invocation. Those three rows
now use the install verbs, which name no range: `bun install -g`, `pnpm add -g`, `yarn global add`. The deno
row gains `-f`, without which it refuses to replace an existing shim and exits 1 — and an upgrade is always
run against an existing shim. Homebrew and npm are unchanged; neither records a range to respect.
