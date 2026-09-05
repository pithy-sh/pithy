# Releasing

How a Pithy release is cut, what has to exist on npm before the first one, and how a release becomes data the dashboard can answer questions from.

Two audiences. **Setup** is done once, by the person who owns the npm organization. **Cutting a release** is the loop after that, and it is two commands.

## The shape of it

A release is started by hand. There is no push trigger — `.github/workflows/release.yml` runs on `workflow_dispatch` only, the same deliberateness `ci.yml` applies to `main`.

```
snapshot -> changeset version -> build records -> publish -> tag & push -> report
```

The order matters and is not rearrangeable. `changeset version` **consumes and deletes** the changeset files, and the release notes live nowhere else until it has written the CHANGELOGs; the new versions do not exist until it has run. So the release records are collected around it — never reconstructed afterwards.

## Setup, once

### 1. The npm organization

Create the `pithy-sh` organization at [npmjs.com/org/create](https://www.npmjs.com/org/create). The scope has to match the package names exactly — every package is `@pithy-sh/<name>`, so the org is `pithy-sh`.

**Turn on two-factor authentication for your own account first.** `npm trust` in step 5 refuses to run without it, and org-level publishing settings are unavailable without it.

The `Free` plan publishes unlimited public packages. Nothing here needs a paid plan.

### 2. Know what will ship

Before anything is published, see what a release would produce. This needs no npm account and changes nothing:

```bash
GITHUB_TOKEN=$(gh auth token) bun run release:local -- --dry-run
```

It versions the packages, prints one line each, and restores the tree.

Read that list carefully — **a version, once published, is permanent.** npm allows unpublishing only within 72 hours, and a name-plus-version can never be reused afterwards.

### 3. The first publish, which cannot use CI

This is the one awkward step, and it is npm's constraint rather than ours.

Trusted publishing is configured **per package, on a package that already exists**. A package that has never been published has no settings page to attach a trusted publisher to, and `npm trust` refuses for the same reason. So the very first version of each of the 22 packages has to be published some other way, and after that CI takes over permanently.

`bun run release:local` is that step. It runs the identical sequence the workflow runs, against `npm login`'s two-hour session rather than a stored token — nothing outlives the afternoon, and there is no credential to rotate or leak.

```bash
npm login                                                       # a 2-hour session, not a stored token
GITHUB_TOKEN=$(gh auth token) bun run release:local -- --dry-run # see it; changes nothing
GITHUB_TOKEN=$(gh auth token) bun run release:local              # publish it
```

The dry run versions the packages, prints one line per package, and then **puts the tree back exactly as it was** — manifests, changesets, generated changelogs and all. The real run prints the same plan and stops for a typed `yes` before it publishes anything.

It refuses to start on a checkout that is not ready, and reports every reason at once: not on `main`, anything uncommitted, behind `origin/main`, nobody logged in to npm, no `GITHUB_TOKEN`, no changesets. A dry run is held to less, because it publishes nothing — it needs only a clean tree, a token, and something to release.

**That first release publishes without provenance.** Provenance is generated from a CI build's OIDC identity, so a laptop cannot produce one. `0.1.0` will carry no attestation and every release after it will. That is the whole cost of the bootstrap.

**The repository must be public before a release with provenance.** npm refuses to verify a sigstore bundle from a private source repository — `E422 … Unsupported GitHub Actions source repository visibility: "private"` — and the workflow sets `NPM_CONFIG_PROVENANCE=true`, so the publish fails outright rather than quietly skipping the attestation. It fails cleanly: nothing publishes, nothing is pushed, and the version bump is never committed.

The claim is captured when the **run is created**, not when the publish step executes, so flipping the repository to public mid-run does not rescue that run. Flip first, then trigger.

`GITHUB_TOKEN` is needed for `changeset version`, not for publishing: `@changesets/changelog-github` calls the GitHub API to attribute each changeset, and the command exits 1 without it.

### 4. Protect the release environment

**Do this before step 5, and do not skip it.** An npm trusted publisher matches on repository and workflow **filename**. It has no branch field — and `workflow_dispatch` runs the workflow definition from whichever ref the dispatcher names. Without an environment, anyone able to push a branch could run a rewritten `release.yml` from it and publish all 22 packages, with genuine provenance attestations that make the result look *more* trustworthy.

The GitHub environment is what pins the ref, because GitHub evaluates its deployment-branch rule against the ref actually executing.

1. Repository **Settings → Environments → New environment**, named exactly `npm-publish`.
2. Under **Deployment branches and tags**, choose *Selected branches and tags* and add a rule for `main`.
3. Optionally add yourself under **Required reviewers**, which makes every release wait for one click.

The workflow already declares `environment: npm-publish` on its `release` job.

### 5. Attach trusted publishers

Now that the packages exist, point each one at this workflow. Requires npm **11.15.0 or later** and 2FA on your account.

```bash
npm install -g npm@latest

for pkg in audit auth cli cloudflare core email i18n leaderboard ledger \
           matchmaking media multiplayer payments rating secrets storage \
           support testers turnstile ui-react vector vite; do
  npm trust github "@pithy-sh/$pkg" \
    --repo pithy-sh/pithy \
    --file release.yml \
    --env npm-publish \
    --allow-publish \
    --yes
  sleep 2   # npm rate-limits this endpoint
done

npm trust list @pithy-sh/core   # confirm one landed
```

`--file` is the workflow **filename only**, not a path. It must stay `release.yml`: renaming the workflow breaks publishing for all 22 packages until every trust is re-pointed.

`--env npm-publish` is what makes step 4 load-bearing — it tells npm to verify the environment claim, so a run from any other ref is refused even though the repository and filename match.

Then, on npm, set each package's publishing access to **"Require two-factor authentication and disallow tokens."** That closes token-based publishing entirely while leaving trusted publishing working — after this, the only thing that can publish `@pithy-sh/*` is this repository's release workflow, from `main`.

### 6. GitHub

**There is nothing to configure.** No `NPM_TOKEN`, no npm secret of any kind. The workflow already declares:

```yaml
permissions:
  contents: write   # push the version commit and the tags
  id-token: write   # npm trusted publishing (OIDC) and provenance
```

`id-token: write` lets the job mint a short-lived OIDC token that npm exchanges for publish rights. It grants no access to anything else.

The only other credential in play is `GITHUB_TOKEN`, which GitHub provides to every workflow run automatically.

## Cutting a release, after setup

```bash
gh workflow run release.yml -f dry_run=true    # see what would ship
gh workflow run release.yml                    # ship it
```

That is the whole loop. The job runs the full gates (Biome, license headers, docs catalog, CLI pack, typecheck, tests, build), versions, publishes, tags, pushes the version commit to `main`, and reports the release.

Anything already on the registry is skipped, so a re-run after a partial failure publishes only what is missing.

A release with no changesets **fails** rather than passing quietly — `@changesets/cli` 3.0.0 exits 1 with nothing to apply. A release that released nothing should say so.

## The version path to 1.0.0

Three releases, deliberately, so each half of the pipeline is proved before it matters.

| | Version | Cut from | Proves |
|---|---|---|---|
| 1 | `0.1.0` | `bun run release:local` | The packages exist on npm, so trusted publishers can be attached. |
| 2 | `0.1.1` | `gh workflow run release.yml` | CI can publish over OIDC, with provenance, unattended. |
| 3 | `1.0.0` | `gh workflow run release.yml` | Nothing. It is the release that means something, cut on a pipeline that already works. |

**Release 2 needs a changeset of its own.** The first release consumes all of them, and `changeset version` exits 1 with nothing to apply — so `0.1.1` does not happen by itself. Write one naming the packages it should move:

```markdown
---
"@pithy-sh/core": patch
---

The release pipeline publishes from CI.
```

A changeset names packages, so only those move. To take all 22 to `0.1.1`, name all 22 — or accept that only some advance, which is what a real release looks like anyway and is the more honest test.

**`1.0.0` is a `major` changeset.** On a `0.x` package Changesets reads `major` as `1.0.0`, so a changeset declaring `major` for each package is how release 3 is cut. Nothing special-cases it.

Until then everything stays on `0.x`, where the minor slot carries breaking changes — which is why `.changeset/412-a-subject-not-a-user.md` declares `minor` for `@pithy-sh/payments` despite describing a genuine break. Left at `major` it would have shipped `payments` at `1.0.0` alone, claiming API stability ahead of `core`.

## Marking a release security-relevant

A changeset carries a semver bump and a summary, and neither says whether a release *matters*. A patch closing a token-reuse hole and a patch fixing a log typo are both `patch`.

So a security-relevant change says so, in its changeset body, at the moment it is written:

```markdown
---
"@pithy-sh/auth": patch
---

Refresh-token reuse now revokes the whole family.

Security: a revoked refresh token stayed valid until its natural expiry.
```

**The first paragraph is the release note — what changed. The `Security:` line is the exposure — what was wrong before.** They are different sentences, and the second is the one a customer decides on.

**In the body, never the frontmatter.** `@changesets/parse` treats every frontmatter key as a package name, so a `security: true` key there declares a package called `security` and breaks `changeset version` outright.

The line flows into `CHANGELOG.md` on purpose. That is what makes git the durable record once the changeset files are consumed, and what lets `replay` below rebuild a record months later.

Marking it while writing it takes a word. Reconstructing the judgment across two years of releases, under pressure, when a customer asks whether they are exposed, is miserable and unreliable.

## Release records, and the dashboard

Every release emits one record per package — the version already split into `major` / `minor` / `patch`, the bump, the note, and the security flag with its exposure sentence.

They are always written to `.release/records.json` and uploaded as the `release-records` artifact on every run, published or not.

### Reporting is configured and currently off

The dashboard endpoint does not exist yet, so the reporting step is off. It is off because nothing is configured — not because a second switch says so, which is a flag that can disagree with reality.

Turn it on by setting both of these, and it starts reporting on the next release with no code change:

| Where | Name | What it is |
|---|---|---|
| Repository **variable** | `RELEASE_RECORDS_URL` | The dashboard's ingest endpoint. Must be `https`. |
| Repository **secret** | `RELEASE_RECORDS_TOKEN` | A scoped credential for that one endpoint. |

```bash
gh variable set RELEASE_RECORDS_URL --body "https://dashboard.pithy.sh/api/releases"
gh secret set RELEASE_RECORDS_TOKEN
```

Until then the step prints `Dashboard reporting is off: no endpoint configured.` and succeeds.

**Never a Cloudflare API token.** Cloudflare tokens are not table-scoped: one able to insert release rows could read and write everything in that database, including the dashboard's users, subscriptions, and the control-plane private keys it holds for every customer. The credential above grants one operation instead of a database.

### A failed write never fails a release

An unreachable dashboard cannot block publishing an open-source package, so the step logs and continues.

The cost is a dashboard silently missing a release. That is recoverable, because the `Security:` marker is visible prose committed to the CHANGELOG:

```bash
bun scripts/releaseRecords.ts replay                          # every package
bun scripts/releaseRecords.ts replay --package @pithy-sh/auth # one
bun scripts/releaseRecords.ts post
```

`replay` rebuilds the records from the CHANGELOGs in git and the `<package>@<version>` tags. It is idempotent and keyed on package and version, so re-running it costs nothing.

A release whose tag cannot date it is **skipped and named**, never dated by guess — the store is keyed on package and version, so a wrong date written once could not be corrected by running this again.

### Releases before the convention

They carry no flag, because nobody made that judgment at the time. That is *unknown*, not *safe*, and the dashboard has to say so rather than implying the release was clean.

Nothing is backfilled. Retroactively deciding whether a two-year-old patch was security-relevant produces a dataset where a wrong "no" reads as an assurance.

## Troubleshooting

**`changeset version` exits 1 with a token error.** `@changesets/changelog-github` needs `GITHUB_TOKEN` to attribute changesets. In CI it is provided; locally use `GITHUB_TOKEN=$(gh auth token)`.

**`changeset version` exits 1 with no changesets.** There is nothing to release. Expected under `@changesets/cli` 3.0.0.

**`npm error 404 Not Found - PUT https://registry.npmjs.org/@pithy-sh%2f<name>`** on an OIDC publish. The trusted publisher is missing or points at the wrong workflow. Check `npm trust list @pithy-sh/<name>` — the repository must be `pithy-sh/pithy` and the file `release.yml`.

**`npm trust` refuses.** It needs npm 11.15.0+, 2FA on your account, write access to the package, and the package to already exist.

**No provenance on a published package.** Provenance needs the `repository` field in `package.json` (all 22 declare it, held by `tooling/release/src/manifests.test.ts`), a public repository, and a CI build. A local publish never produces one.

## What a package publishes

Every published package declares `files`, and two gates hold it:

- `tooling/release/src/manifests.test.ts` — the declaration. Each package names `src`, negates `!src/**/*.test.ts`, ships its `pithy.manifest.json` where it has one, ships its `docs/`, and names nothing that is not there.
- `bun run verify-published` — the artifact. It packs all 22 and fails on a test file, a build leftover, or a missing manifest. It runs in CI beside the CLI's own `pack:verify`, and again in the release workflow on the exact thing about to be published.

Both exist because **`files` does not fail on a missing path.** A field naming `pithy.manifest.json` passes every static check whether the file is there or not, and only the tarball knows the difference — which matters, because the CLI resolves every capability manifest from the adopter's `node_modules/@pithy-sh/*`. A package that ships without one is a capability `pithy add` cannot see, and it exits 0.

The one deliberate exception is `templates/`: the CLI vendors a starter an adopter scaffolds, tests included, and `packages/cli/scripts/verifyPack.ts` pins those files to the git index.
