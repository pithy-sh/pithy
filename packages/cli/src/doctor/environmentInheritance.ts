// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import { discoverWorkers, type WorkerTarget } from "../project/workers";
import { readWranglerConfig } from "../project/wrangler";
import { describeUnrepeatedKey, unrepeatedKeys } from "../project/wranglerInheritance";

/**
 * **Does every environment stanza repeat the top-level keys it does not inherit?** (#581)
 *
 * Most of a `wrangler.jsonc` flows down into `env.<name>`. A minority does not, and a key in that minority
 * declared at the top level and left out of a stanza is **absent** in that environment — not defaulted, not
 * inherited. The environment deploys without it, wrangler prints one warning inside a deploy whose output
 * is captured (#578), and nothing else ever says so.
 *
 * The kit's own first adopter shipped exactly that: `version_metadata` at the top level, missing from both
 * `env.staging` and `env.prod`, so neither deployed environment had the `CF_VERSION_METADATA` binding that
 * `verifyDeployedVersion` reads — and that check was therefore permanently inconclusive on the only two
 * environments where it matters. Nobody noticed for as long as nothing was deployed there.
 *
 * **Doctor is where this belongs rather than deploy.** The file is already read here for the binding,
 * origin and environment checks, and the reader of a `doctor` report is looking for configuration faults.
 * The reader of a deploy is watching a deploy.
 *
 * ## It reports and never fails the exit
 *
 * Every project scaffolded before this landed is in violation for `version_metadata`, because the template
 * they copied from was. That is a step not yet taken rather than a contradiction the project's own files
 * establish, and it takes the same verdict its neighbors do — `devVars`, `devSecrets` and `secretBindings`
 * all report without gating, for exactly this reason. An upgrade that turns a green `pithy doctor` red in
 * CI is a surprise rather than a diagnosis.
 *
 * ## What it does not decide
 *
 * **Which keys are inherited is not decided here.** `project/wranglerInheritance.ts` holds the one
 * declaration, gated against wrangler's own `notInheritable(…)` call sites — because the four-name list
 * this issue opened with was wrong about two of its four names within a day of being written.
 *
 * **Files only.** No account call, so it answers offline, in the project that is not working.
 */

/** What this check established. Listed positively, so an inconclusive read never reads as a pass. */
export type EnvironmentInheritanceState =
  /** Every stanza repeats every non-inherited key its top level declares. */
  | "ok"
  /** A `wrangler.jsonc` would not parse, or the Worker set would not enumerate. Nothing was established. */
  | "could-not-check"
  /** At least one stanza silently goes without something its top level declares. */
  | "unrepeated";

/** One non-inherited key a Worker's environment stanza did not repeat. */
export interface UnrepeatedTopLevelKey {
  /** The Worker's `apps/<name>` directory — the same name the environments block above it uses. */
  worker: string;
  /** The `env.<name>` stanza that omits it. */
  env: string;
  /** The wrangler key, as it is written in the file. */
  key: string;
  /** The bindings or variables that environment goes without, read out of the top-level value itself. */
  carries: readonly string[];
}

/** What `doctor` learned about what this project's environments inherit. */
export interface EnvironmentInheritanceCheck {
  state: EnvironmentInheritanceState;
  unrepeated: UnrepeatedTopLevelKey[];
}

/** Walk every Worker's `wrangler.jsonc` and collect what its stanzas did not repeat. */
export async function checkEnvironmentInheritance(projectDir: string): Promise<EnvironmentInheritanceCheck> {
  let workers: WorkerTarget[];
  try {
    workers = await discoverWorkers(projectDir);
  } catch {
    return { state: "could-not-check", unrepeated: [] };
  }

  const unrepeated: UnrepeatedTopLevelKey[] = [];
  let unreadable = false;
  for (const target of workers) {
    // A process in the dev set with no `wrangler.jsonc` — a Vite frontend — has no top level to inherit
    // from and no stanzas to inherit into.
    if (target.hasWrangler === false) continue;
    let config: unknown;
    try {
      config = await readWranglerConfig(target.dir);
    } catch {
      unreadable = true;
      continue;
    }
    const worker = basename(target.dir);
    for (const found of unrepeatedKeys(config)) unrepeated.push({ worker, ...found });
  }

  // A finding is reported even when a neighboring file would not parse: one unreadable Worker must cost
  // its own verdict and nothing else. The `could-not-check` state is only for a run that found nothing,
  // where silence would otherwise read as a pass.
  if (unrepeated.length > 0) return { state: "unrepeated", unrepeated };
  return { state: unreadable ? "could-not-check" : "ok", unrepeated: [] };
}

/**
 * One line per finding, or none at all — the block is the finding.
 *
 * The Worker's name leads, because the block groups several Workers and the reader needs to know which
 * file to open before they read what is wrong with it. The rest of the sentence is
 * {@link describeUnrepeatedKey}'s, unchanged: the cost is read out of the adopter's own value, so this
 * never carries a second wording of the same fact.
 */
export function describeEnvironmentInheritance(check: EnvironmentInheritanceCheck): string[] {
  return check.unrepeated.map((found) => `${found.worker}: ${describeUnrepeatedKey(found)}`);
}
