---
"@pithy-sh/cli": patch
---

A change to the starter template runs the tests that guard it.

CI plans its test matrix by mapping changed paths to workspace packages. `templates/starter` belongs
to no workspace and is not repo-wide, so a PR touching only the template resolved to nothing: zero
packages, `any: false`, every test job skipped. Measured before the fix, on a one-line edit to
`templates/starter/pithy.config.ts` — `count: 0`. The regression test holding a published CLI to the
template it scaffolds from never ran on the PRs that change that template.

The template is `@pithy-sh/cli`'s asset — the CLI scaffolds from it, and the CLI's suite is the only
one that reads it — so a `templates/` change now plans that package. Not the whole repo: this is a
narrowing the affected calculation was missing, not a repo-wide file.

It could not be written as `--affected --filter=@pithy-sh/cli`. Turbo intersects those two, and on a
templates-only diff the intersection is empty — the same silence, arrived at by a longer route. The
affected set is spelled as a filter so it unions with the CLI's, and the two forms return identical
package lists on a templates-only diff and on a `core` diff that cascades to all 21.
