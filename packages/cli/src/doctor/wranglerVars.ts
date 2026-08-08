// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readWranglerConfig } from "../project/wrangler";

/**
 * Every variable name one Worker's `wrangler.jsonc` declares — the top-level `vars` block **and** every
 * `env.<name>.vars`.
 *
 * **`env.<name>.vars` REPLACES the top-level block rather than merging it**, which is the gotcha the
 * starter's own `wrangler.jsonc` comment warns about: every environment repeats every variable. So a
 * name counts as declared if it appears at the top level **or** in any environment — reading only the
 * top level names a staging-only variable as undeclared, and reading only one environment names every
 * ordinary variable as undeclared.
 *
 * **It lives here rather than in either caller.** Two doctor checks ask this question — what a
 * `.dev.vars.local` key has behind it, and what a root `.dev.vars` key has behind it — and a rule this
 * easy to get half-right is a rule that must exist once. An unreadable or absent config declares
 * nothing, which is the honest answer: the health block is where a `wrangler.jsonc` that will not parse
 * gets said, and louder.
 */
export async function declaredVars(workerDir: string): Promise<Set<string>> {
  const config = (await readWranglerConfig(workerDir).catch(() => null)) as {
    vars?: Record<string, unknown>;
    env?: Record<string, { vars?: Record<string, unknown> } | undefined>;
  } | null;
  const keys = new Set<string>();
  for (const key of Object.keys(config?.vars ?? {})) keys.add(key);
  for (const environment of Object.values(config?.env ?? {})) {
    for (const key of Object.keys(environment?.vars ?? {})) keys.add(key);
  }
  return keys;
}
