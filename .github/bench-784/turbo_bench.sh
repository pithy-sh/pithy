#!/usr/bin/env bash
# Time `turbo run typecheck --force` under tsc and under bun check, builds already warm.
#
# Usage: turbo_bench.sh <repo-root> <runs> <out.tsv>
#
# The bun check variant rewrites every workspace's typecheck script in place, `tsc` -> `bun check`, and
# restores the manifests from git on exit, whatever happens. Runs alternate between the two variants.
set -euo pipefail
root=$1 runs=$2 out=$3
cd "$root"

manifests=$(git ls-files '*package.json' | grep -v '^package.json$')
restore() { git checkout -- $manifests; }
trap restore EXIT

to_bun() {
  # Only the typecheck line, so `build`'s `tsc -p tsconfig.build.json` is untouched.
  sed -i -E '/"typecheck":/ s/([" ])tsc /\1bun check /g' $manifests
}

once() {
  local start end
  start=$(date +%s.%N)
  # `--only`: builds are already in `dist/`, and the rewritten manifests would otherwise bust their hashes.
  bunx turbo run typecheck --force --only --continue=always --output-logs=errors-only > /dev/null 2>&1 || echo "  (non-zero exit)" >&2
  end=$(date +%s.%N)
  echo "$end - $start" | bc
}

echo -e "variant\trun\tseconds" > "$out"
# Warm-up, one of each.
restore; once > /dev/null
to_bun; once > /dev/null
for i in $(seq 1 "$runs"); do
  restore; echo -e "tsc\t$i\t$(once)" >> "$out"
  to_bun;  echo -e "bun\t$i\t$(once)" >> "$out"
done
cat "$out"
