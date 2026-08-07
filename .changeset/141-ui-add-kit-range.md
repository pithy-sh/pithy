---
"@pithy-sh/cli": patch
---

`pithy ui add` writes a `@pithy-sh/vite` range the registry can resolve.

The stub hardcoded `"@pithy-sh/vite": "^0.0.0"`. It was dropped only for a project that linked the package in from a checkout — resolved from outside `node_modules`. Every other adopter kept the line, and their next `bun install` 404'd, on a command days away from the one that planted it.

Publication would not have fixed it. The literal never moves, so the release that made every sibling range correct would have left this one at `^0.0.0`, alone and still wrong. The range is now `kitRange(PACKAGE_VERSION)`, the same rule the starter template's kit dependency follows: a real version writes the range, `0.0.0` writes nothing at all. A stub may now declare a `null` range for any package, meaning "needed, but there is no version to name yet".

Found by replaying an adopter sequence from an empty directory against a registry-style install, not by a test — 1704 of those were green.
