---
"@pithy-sh/cli": patch
---

`pithy` runs on Node. The binary was raw TypeScript behind a `bun` shebang, so it installed for everyone and started for nobody without Bun.

```
$ PATH=without-bun pithy --version
/usr/bin/env: 'bun': No such file or directory
```

`bin` is `./dist/bin.js` now, behind `#!/usr/bin/env node`. Bun was never a runtime this code needed — nothing under `src` uses a `Bun.*` API or imports from `bun:` — it was loading TypeScript, and every package having a build ended that job. One shebang serves everyone, because Bun runs plain JavaScript; a `bun`-else-`node` dispatcher would need the same build for its fallback and adds a branch that can be wrong.

**Wrangler runs through your project's package manager, not through Bun.** Every command that reaches Cloudflare shelled out to `bun x wrangler`, and reported `Is wrangler installed and on PATH?` when wrangler was installed and Bun was what was missing. It reads your lockfile now — `bun x`, `pnpm exec`, `yarn`, or `npx` — and if the runner itself is absent, it names the runner.

**Packages build unbundled, so a module keeps its own path.** Left to bundle, rolldown hoists shared code into chunks at the output root, which moves any path a module computes from `import.meta.url`: `pithy init` looked for its vendored starter one directory above the package and reported `This pithy install is missing its starter template` on an install that had it. `dist/` mirrors `src/` exactly now, which is what three separate rules were already assuming.

The clean room runs `pithy` with Bun removed from PATH, and `bun run verify-published` refuses a `bin` that is TypeScript or that the tarball does not carry.
