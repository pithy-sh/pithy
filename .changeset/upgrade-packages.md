---
"@pithy-sh/cli": minor
---

`pithy upgrade --packages` moves the project's `@pithy-sh/*` dependencies, and `pithy doctor` now names the command that clears its line. Doctor used to tell every outdated package to run `pithy upgrade`, and `upgrade` reconciles config and wiring and never moved a version, so following the advice printed the same line again.

`--packages` reads every `@pithy-sh/*` declaration in the root and `apps/*` manifests, `@pithy-sh/cli` included, and moves each `^`, `~` or exact range to the newest version it admits by rewriting the floor and keeping the operator. It installs once, at the root, under one rollback with the manifests and the lockfile, reads back what landed, and then reconciles in the same run. A version beyond a breaking boundary — a new major, or a new minor under `0.x` — is held and named; `--latest` is the explicit opt-in that crosses it. Workspace, link, git and other non-registry specs, and packages linked in from a checkout, are left alone and said so. A registry that does not answer moves nothing and fails the run. When `@pithy-sh/cli` itself moves, the reconcile is left to the new CLI.

**It names the copied templates the move changed.** For each Worker with a React front end, the templates installed now are compared with the ones the move installs — read from disk, or from the published tarball after its `sha512` integrity is checked — and every copied file whose template changed is named: untouched, edited and needing a merge, new, or gone. It runs on patch moves too, because the refusal-code change a copied sign-in screen has to follow landed in the `@pithy-sh/ui-react` 0.3.0 → 0.3.1 patch. Nothing is rewritten.

Doctor's rows gain `command` and `declaredAs` in `--json`. The command is `pithy upgrade --packages` when every declared range admits `latest`, `pithy upgrade --packages --latest` otherwise, with a note when it crosses a breaking boundary, and none at all for a package the project does not declare or declares in a shape `--packages` leaves alone. `pithy upgrade` without the flag is unchanged.
