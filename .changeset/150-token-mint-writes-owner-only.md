---
"@pithy-sh/cli": patch
---

`pithy token mint --store dev-vars` no longer writes a live Cloudflare token world-readable.

The sink had its own copy of the `.dev.vars` upsert, and the copy called `writeFileAtomic` with no mode. An existing target keeps its own permissions and a file that does not exist yet has none, so creation fell through to the umask: minting for an environment with no `.dev.vars.<env>` yet put a **production** Cloudflare API token on disk at `0664`. Every test covering this wrote into a file the fixture had already created, which is exactly why it survived the mode fix that went in with #146.

The sink now goes through `upsertDevVars` — the one thing that should ever be writing one of these files, and the one that already applies `0600` on create. The duplicate is gone with it, along with a second, worse line-matcher: it kept a line's original text when only its indentation differed and never dropped a duplicate key, so a file with the same key twice could be rewritten and still read back the stale value.

Every other `writeFileAtomic` caller was checked. `wrangler.jsonc`, `pithy.config.ts`, `pithy.worker.jsonc`, `package.json`, `.dev.config.json`, `.dev-ports.json`, `.dev-state.json`, `.pithy-feature.json` and the notifier's state file write configuration and local state, no credentials, and are left at the umask deliberately. `.dev.vars` and its per-environment siblings were the only secrets, and had the only two producers.
