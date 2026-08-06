---
"@pithy-sh/cli": patch
---

Vendoring publishes what is committed, and nothing else.

`prepack` copied `templates/starter` recursively with no filter, and `files` overrides `.gitignore`.
Against the real packer, with a maintainer's working tree: `templates/starter/.dev.vars` and an
untracked scratch file both went into the tarball. That file is where `pithy add` and
`pithy token mint` write `CLOUDFLARE_API_TOKEN` and `SECRETS_ENCRYPTION_KEYS`. Publishing is
irreversible.

The allowlist is now the git index — `git ls-files --cached`, copied file by file, never the
directory. An exclusion filter was the other option and it is the weaker one: a filter has to predict
the next artefact somebody drops in that directory, and nobody predicted this one. A file ships
because it was committed, reviewed and pushed. Symlinks are refused, and a failed copy takes the
half-written `templates/` with it rather than leaving it to shadow the repo root.

`bun run pack:verify` is the post-condition the mechanism lacked. `files` does not fail on a missing
path, so a pack with lifecycle scripts disabled shipped a CLI with no template at all — silently,
exit 0, the very defect `prepack` was added to close. No script the manifest declares can run during
a pack that refuses to run scripts, so the check sits on the artefact instead: it holds a tarball to
the index, and CI runs it on every commit. `files` carries `scripts/` now, because a published
manifest naming `prepack` and `postpack` has to carry what they run — and both are no-ops outside a
checkout, so neither can delete the template out of an installed package.

Template resolution prefers the checkout and reaches the packaged copy second, and it will not leave
the package to find one. Four levels up from `src/project` is the repo root in a checkout and
`<node_modules>/templates/starter` in an install — a path owned by any dependency named `templates`.
It is now reachable only when this module really sits under a repo root's `packages/cli`.

The packaging test asserts the tarball holds *nothing* beyond the committed template, packs a
throwaway checkout whose working tree is deliberately dirty, and no longer packs the live package
underneath the suites scaffolding from it. The old assertion was a superset with a secret inside it,
and it passed.
