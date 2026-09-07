---
"@pithy-sh/cli": patch
"@pithy-sh/core": patch
---

Your `pithy.config.ts` can import your own modules again.

0.1.4 could not load a config containing an ordinary TypeScript import of a local file:

```
Nothing resolves ".../apps/board/src/secret/registry"
```

The file was there. Until #481 the CLI ran on Bun, whose resolver reads `./src/secret/registry` as `registry.ts`; it runs on node now, which strips types from the config and then refuses the extensionless specifier inside it. Reported by `pithy-sh/dashboard`, whose config has eleven such imports.

The CLI registers a `node:module` resolve hook before loading a config. It runs only after node's own resolution has failed, and only for relative specifiers — a bare specifier is a package and stays with node and the `exports` map.

**Every distributed file now carries its SPDX notice**, built from the package's own declared license through the same `buildHeader` that stamps source. `@pithy-sh/audit` is `FSL-1.1-MIT`, so this is not decoration: its compiled output would otherwise have claimed MIT while its source said FSL. `bun run verify-published` refuses a tarball missing one.

**`@pithy-sh/cli` now declares `node >=22.18.0`**, which is what it has always needed — unflagged type stripping, without which a `.ts` config cannot be imported at all. The libraries ship compiled JavaScript and still run on 22.0. `pithy` refuses an older node at startup with a message naming both versions, because `engines` only warns unless you set `engine-strict`.
