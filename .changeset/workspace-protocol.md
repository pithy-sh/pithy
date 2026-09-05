---
"@pithy-sh/audit": patch
"@pithy-sh/auth": patch
"@pithy-sh/cli": patch
"@pithy-sh/cloudflare": patch
"@pithy-sh/core": patch
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
"@pithy-sh/ui-react": patch
"@pithy-sh/vector": patch
"@pithy-sh/vite": patch
---

Every package installs from npm. Twenty of them did not.

`0.1.0` and `0.1.1` published their dependencies on sibling packages as `workspace:*`. That is a Bun, pnpm and yarn convention, and **npm does not implement it** — measured both ways, `npm pack` leaves it verbatim from the package directory and from the repository root with `-w`. Changesets publishes through `npm publish`, so the range reached the registry unrewritten and no resolver could do anything with it. `bun add @pithy-sh/cli` failed before installing anything. Only `core` and `ui-react` worked, because they depend on no sibling.

Internal dependencies now carry a concrete range, which Changesets already maintains across releases, and which still resolves to the workspace locally — a package's siblings link exactly as before.

**Nothing in this repository could have caught it.** Every test here runs inside the workspace, where `workspace:*` resolves perfectly; the range is only wrong once it leaves. So the check moved to where the evidence is: `verify-published` now extracts the manifest from a real tarball rather than reading the one on disk, and fails on a workspace range in anything a consumer installs. A devDependency keeps it, because a consumer never installs one.
