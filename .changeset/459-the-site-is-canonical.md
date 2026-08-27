---
"@pithy-sh/audit": patch
"@pithy-sh/auth": patch
"@pithy-sh/cli": patch
"@pithy-sh/cloudflare": patch
"@pithy-sh/email": patch
"@pithy-sh/i18n": patch
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

The documentation is on `pithy.sh/docs`, and the kit now says so.

Every package README is a front door: what it is, `pithy add <name>`, and the link. 3,749 lines became 509. Five documents the site fully carries are retired, and the rest each carry a line naming the page that renders them.

What stays, and why, is now one rule in `CONTRIBUTING.md`. A document a test reads off disk is specification rather than documentation — `docs/CLI.md`, the twenty-six command pages, `docs/NAMING.md`, `docs/I18N.md` — so it does not move. A document something here names reaches an adopter through a config error, so it stays where it is: eight under `docs/` and the per-package pages a manifest, a catalog entry or a source comment sends a reader to. `docs/BRAND.md`, `docs/CONVENTIONS.md` and `docs/STACK.md` are neither, because they are written for a contributor and the site does not render them.

`docs/DEPLOY.md` is the fifth retirement and the only one that was also wrong. It said the scaffold is a single Worker with `wrangler.jsonc` at the root and that deploy falls back to it — but `templates/starter/apps/` is the scaffold and `scaffoldWorker` stamps into `apps/<name>/`, so the fallback it described has no scaffold to catch. Nothing in the repository read it; `docs/commands/deploy.md`, `docs/commands/migrate.md` and `docs/UI.md` linked to it, and all three now point at the site.

The kit also exports what it contains. `docs/catalog.generated.json` names every capability, every command's flags and every error code the kit defines, so the site's docs check reads a value instead of a regular expression over TypeScript — the read that once lost `i18n` to a character class with no digits in it. CI fails on a stale one, because a stale export does not fail the site's check: it passes every page against a kit that has moved.

`globalFlags` names the six flags parsed outside any command's `args` — `--help` and `--version` in both spellings, and the hidden `--pithier` and `--pithiest`. It is composed from the modules that answer them rather than listed, because the hidden pair was missed on the first pass and a list would have gone stale again on the seventh. Hidden from `--help` is not hidden from a docs check: `docs/commands/alias.md` documents both, and an export without them makes a page the kit's own tests pin read as citing flags that do not exist.

`commands[].flags` carries every spelling citty answers to, not only the declared one — the camelCase form of a kebab-case name, and `--no-<name>` on a boolean. Both are citty's own behavior rather than ours, and both were false failures waiting to happen: `docs/commands/ui.md` puts `[--auth | --no-auth]` in its synopsis and `ui.ts`'s own description offers `--no-auth for the bare SPA`, so an export without it reported the most carefully written pages as the wrong ones.
