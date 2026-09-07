---
"@pithy-sh/cli": patch
"@pithy-sh/i18n": patch
"@pithy-sh/payments": patch
---

A scaffolded Worker declares the runtimes its capabilities require, so the project can load them.

0.1.3 made `zod`, `kysely` and `hono` peer dependencies of every capability — one copy is one type — and shipped without the other half. A peer is a requirement the *consumer* satisfies: npm installs one at the top, and **bun, for a workspace member, does not**. So a project scaffolded by `pithy init` declared its capabilities, nothing declared their peers, and `@pithy-sh/core` could not load inside it at all:

```
$ node -e 'import("@pithy-sh/core/src/error/pithyError")'   # from apps/board
ERR_MODULE_NOT_FOUND: Cannot find package '@pithy-sh/core'
```

`hono` was the one of the three that never broke, because the Worker template had always declared it. `zod` and `kysely` are declared beside it now, by both producers of a Worker manifest.

**`pithy add` carries a capability's required peers with it**, read from the installed package rather than from a list, so a capability that needs something new is handled without a release. Two kinds are skipped: an optional peer — `payments` and `i18n` declare `react`, used only by their `client/` and `react/` modules, and a server composition never loads one — and a kit sibling, which is a prerequisite the CLI already refuses on and names.

`react` is marked `optional` on those two, which is what it always was.

If you are on 0.1.3 and your Worker builds, you already declare these and nothing changes. If it does not, upgrading fixes it — or add `zod` and `kysely` to `apps/<worker>/package.json` by hand.
