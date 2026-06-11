// Run Biome over staged files only. No --write: a violation must fail the commit,
// not be silently fixed underneath it. Fix, restage, commit again.
export default {
  "*": "biome check --no-errors-on-unmatched --files-ignore-unknown=true",
};
