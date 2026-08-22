---
"@pithy-sh/audit": patch
"@pithy-sh/auth": patch
"@pithy-sh/cli": patch
"@pithy-sh/core": patch
"@pithy-sh/email": patch
"@pithy-sh/leaderboard": patch
"@pithy-sh/ledger": patch
"@pithy-sh/matchmaking": patch
"@pithy-sh/media": patch
"@pithy-sh/multiplayer": patch
"@pithy-sh/payments": patch
"@pithy-sh/rating": patch
"@pithy-sh/secrets": patch
"@pithy-sh/storage": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
"@pithy-sh/turnstile": patch
"@pithy-sh/vector": patch
---

The Workers Vitest integration is `@cloudflare/vitest-plugin`, and a scaffolded project says so.

Cloudflare published version 1 of the Workers Vitest integration under a new name. `@cloudflare/vitest-pool-workers` is `@cloudflare/vitest-plugin`, and the configuration API is unchanged. The old name is not deprecated on npm — its `latest` is `0.22.0`, published two days before `@cloudflare/vitest-plugin@1.0.0` — but version 1 is where the integration continues, so that is what to follow. Every package here takes the new one at `^1.0.0`.

**Your repository needs the same three edits**, and a `pithy init` scaffold has already had them. The dependency in `package.json`, the `cloudflareTest` import in `vitest.workers.config.ts`, and the `/// <reference types="@cloudflare/vitest-plugin/types" />` line in `cloudflare-test.d.ts`. Cloudflare ship a codemod that does all three — `bunx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin`, with `--dry-run` to read it first. It rewrites prose as readily as code, so check what it touched.

**Seventeen of these eighteen releases change nothing you can run, and that is the point.** Bytes do move in all eighteen tarballs — `bun pm pack --dry-run` shows every capability package shipping its `package.json`, its `src/cloudflare-test.d.ts`, and in sixteen cases its `vitest.workers.config.ts`, and this commit rewrites all three. None of them is runtime code: a devDependency name, a `/// <reference types>` line, and a test config. Nothing an import of `@pithy-sh/<capability>` reaches is touched. A patch version that says so is how the note above gets to the repositories that need it. `@pithy-sh/cli` is the one real change: it vendors `templates/starter`, so `pithy init` now scaffolds the new name.

**The rename is not free, and the cost is one line of `docs/STACK.md`.** The old caret held the test harness on `miniflare` 4 for nothing — for a `0.x` package it resolved below the 0.20.0 that first pinned a `miniflare@5.x-alpha`. Version 1 is that same line renamed, so `*.workers.test.ts` now runs on `miniflare@5.20260820.0-alpha` and workerd `1.20260820.1`. That is dev-side only, and it is not the first alpha here: `wrangler` is a devDependency of eighteen packages under `packages/`, hoisting to one `wrangler@4.123.0` that has carried a nested 5.x-alpha for our own suites all along. The kit ships no wrangler — `pithy dev` execs the one in your repository. What the kit *does* ship is `miniflare` itself, a runtime dependency of `@pithy-sh/cli` that `pithy migrate` and `pithy seed` construct, and that stays declared at `^4.20260722.1`. So the harness and the migrator now run different workerd builds, and no common compatibility date holds them together — nothing the CLI constructs `Miniflare` with passes one. `docs/STACK.md` names that exposure rather than leaving it to be found.

`packages/core/src/worker/envIsolation.workers.test.ts` is new, and pins the `process.env` a workers test sees. `@pithy-sh/core` declares no `files` and carries no `.npmignore`, so `src` packs whole and that file goes to the registry with it — the second tarball here to gain content rather than only rename it. That is core's packaging, unchanged by this commit and not a thing to fix inside it. The test-isolation gate exempts workers projects because workerd inherits nothing from the host, and that reason was a comment reporting a count from an older workerd. It is an assertion now — and the gate resolves the path it cites, so the evidence cannot be renamed away while the exemption stays green.

Nothing in this repository reached for `fetchMock` from `cloudflare:test`. It went in 0.13.0 — the same single release that replaced `defineWorkersConfig`/`poolOptions.workers` with the `cloudflareTest` plugin, and the one `packages/core/vitest.workers.config.ts` names for that. 0.12.21 still exports `defineWorkersConfig` and still ships `fetchMock`; 0.13.0 exports neither. `cloudflare:test` is imported for `env`, `runInDurableObject` and `runDurableObjectAlarm`, and for nothing else.
