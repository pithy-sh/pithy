---
"@pithy-sh/cli": patch
---

Pithy can cut a release, and a release says whether it mattered.

There was no release process. The root `release` script exited 1, no workflow published anything, and a Changeset carried a semver bump and a summary — neither of which says whether a patch closed a token-reuse hole or fixed a log typo. Both are `patch`, and anyone asking "should I upgrade urgently" had to read every note in between and judge.

`.github/workflows/release.yml` is the pipeline: started by hand, gated on the full suite, versioning through Changesets, publishing over npm trusted publishing with provenance, tagging, and reporting what shipped. `dry_run` versions and prints the plan without publishing anything.

A security-relevant change now says so where it is written — a `Security:` line in the changeset body naming **what the exposure was**, which is a different sentence from the note describing the fix. In the body rather than the frontmatter, because `@changesets/parse` reads every frontmatter key as a package name. Visible on purpose: it flows into `CHANGELOG.md`, so git becomes the durable record once the changeset files are consumed.

Each release emits one record per package, with the version already split into components so a comparison is a column predicate rather than semver logic in SQL. Collected around `changeset version` rather than after it, because that command deletes the files the notes live in. The write to the dashboard is configured and off until the dashboard exists, and it can never fail a release — so `replay` rebuilds the records from the CHANGELOGs and the tags, idempotent and keyed on package and version. Verified against this repository's own 381 changesets: replay reproduces all 22 live records byte for byte.

`bun run release:local` cuts the one release CI cannot: npm attaches a trusted publisher only to a package that already exists, so the first version of each package is published from a laptop under `npm login`'s two-hour session — no stored token, nothing to rotate. It refuses a checkout that is not ready and says every reason at once, and `--dry-run` versions the packages, prints what would ship, and puts the tree back exactly as it was.

Every published package now declares `repository`, without which npm generates no provenance at all — silently, and it also declares `files`. Nothing did before, so `npm publish` took whatever git did not ignore: half of `@pithy-sh/core`'s tarball was its own test files, and `@pithy-sh/payments` shipped 93 of them while declaring a `files` field that listed what to include and never the negation that leaves tests out. Two gates hold it now — one on the manifests, one on the packed artifact, because `files` does not fail on a missing path and a manifest named but absent is a capability `pithy add` cannot see.

**Only `main` can publish, and only the release step holds the key.** An npm trusted publisher matches on repository and workflow filename and has no branch field, while `workflow_dispatch` runs the workflow definition from whichever ref it is pointed at — so anyone able to push a branch could have run a rewritten `release.yml` and published all 22 packages, with genuine provenance making the result look more trustworthy rather than less. A protected `npm-publish` environment pins the ref, and every trusted publisher is registered against it. The gates run in a second job holding `contents: read` and no OIDC, so the publish credential is never in the same process as the test suite.

The spelling gate reaches the prose that ships. `.changeset/*.md` becomes `CHANGELOG.md` inside the tarball, and it was outside the gate's scope — 112 en-GB spellings were queued to reach adopters on the first release. `scripts/` and `.github/` came in with it, the sweep is done, and the boundary that deferred it is gone.
