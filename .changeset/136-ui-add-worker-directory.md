---
"@pithy-sh/cli": patch
---

`pithy ui add` names the worker by its directory.

A Worker has two names: it deploys as `<project>-<worker>` and it lives at `apps/<worker>`. `pithy ui add` took the first and wrote it where the second belongs, so a project scaffolded `--name replay --worker board` got `./apps/replay-board/tsconfig.client.json` in its root solution file — a reference to a directory that has never existed. `bun run typecheck` stopped on TS6053, and Vite, which resolves a worker's config through that same file, could not load `apps/board/vite.config.ts` at all: `pithy dev` left a dead server on a project the adopter had not yet touched.

Everything the flow names is a path or a `--worker` value, and both are the directory — the solution file's references, the client's `tsBuildInfoFile`, the actionable errors, and the `worker` field of `--json`. The deployed name belongs in `wrangler.jsonc` and nowhere else.
