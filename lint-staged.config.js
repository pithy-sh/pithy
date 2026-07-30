// Run Biome over staged files only. No --write: a violation must fail the commit,
// not be silently fixed underneath it. Fix, restage, commit again.
//
// The SPDX header is the one deliberate exception, and it is worth being explicit about why.
// Biome's findings are judgements about code the author wrote — surfacing them teaches something,
// and rewriting them underneath the commit hides a decision. A licence header is neither: it is
// boilerplate with exactly one correct value, derived from the package's own `license` field, that
// the author has no opinion about and nothing to learn from. Failing the commit would only mean
// typing `--fix` and committing again.
//
// It runs per-path, not repo-wide, because lint-staged re-stages only the files it passed to the
// task: a repo-wide fix would write correct headers and leave every one of them unstaged.
// These two globs overlap on every staged `packages/*/src/**/*.ts`: one reads it, the other rewrites
// it. lint-staged runs different globs' tasks concurrently by default, and `writeFileSync` truncates
// before it writes — so Biome could read a file mid-stamp and fail the commit with a parse error in
// code that is perfectly valid. `.husky/pre-commit` passes `--concurrent false` to serialise them.
// The flag lives there and not here because lint-staged v17 validates every key of this object as a
// glob: a `concurrent: false` entry is a config parse error, not an option.
export default {
  "*": "biome check --no-errors-on-unmatched --files-ignore-unknown=true",
  "{packages,tooling}/*/src/**/*.{ts,tsx}": "bun scripts/license-headers.ts --fix",
};
