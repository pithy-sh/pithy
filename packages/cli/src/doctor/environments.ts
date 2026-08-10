// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import { loadProject, loadProjectEnvironments } from "../project/config";
import { discoverWorkers, type WorkerTarget } from "../project/workers";
import { readWranglerConfig } from "../project/wrangler";

/**
 * **Does every Worker still declare the environments this project says it has?** (#241)
 *
 * The root `pithy.config.ts` declares the set; each Worker's `wrangler.jsonc` records which of them it has
 * a stanza for. Before the declaration existed there was nothing to compare a stanza to — two Workers in
 * one project could declare different environments and nothing reconciled them, and a project could
 * acquire `env.live` that `pithy secrets provision` would never give a master key.
 *
 * Two different faults live here, and they are worth telling apart because the remedies are opposite:
 *
 * - **A disagreement.** A Worker declares an environment the project does not, or is missing one it does.
 *   Nothing has been provisioned under it; the fix is an edit to one file or the other.
 * - **An orphan.** The same undeclared stanza, but carrying **resource ids** — so resources were created
 *   under a name this project no longer claims. That is a declaration changed *after* provisioning, and
 *   the answer is never "apply it": `<project>-<env>-<thing>` is recomputed, never stored, so renaming an
 *   environment does not rename a database. It orphans it, exactly as renaming `name` does. This reports
 *   it and stops.
 *
 * **Files only.** No account call, so it answers offline, in the project that is not working — and its
 * verdict is established by this repo contradicting itself, which is the standard `doctorExitCode` holds
 * a gating check to.
 */

/** What this check established. Listed positively, so an inconclusive read never gates CI. */
export type EnvironmentsState =
  /** Every Worker's stanzas are exactly the declared set. */
  | "ok"
  /** A `wrangler.jsonc` would not parse, the root config would not load, or the worker set would not enumerate. */
  | "could-not-check"
  /** A Worker's stanzas and the declaration contradict each other. Established from local files alone. */
  | "drifted";

/** One Worker-and-environment disagreement. */
export interface EnvironmentDrift {
  /** The Worker's `apps/<name>` directory. */
  worker: string;
  /** The environment the stanza names, or the declared one that has no stanza. */
  env: string;
  /** Which of the three faults this is. */
  kind: "undeclared" | "orphaned" | "missing";
  /** The resource ids found under an orphaned environment — the evidence, never a secret. */
  resources: string[];
}

/** What `doctor` learned about this project's environments. */
export interface EnvironmentsCheck {
  state: EnvironmentsState;
  /** The declared set, in declaration order — so the report says what it compared against. */
  declared: string[];
  drift: EnvironmentDrift[];
}

/** The `wrangler.jsonc` keys this reads: the environment stanzas and the binding ids inside them. */
interface StanzaBindings {
  d1_databases?: { binding?: string; database_id?: string }[];
  kv_namespaces?: { binding?: string; id?: string }[];
  r2_buckets?: { binding?: string; bucket_name?: string }[];
  vectorize?: { binding?: string; index_name?: string }[];
  env?: Record<string, StanzaBindings | undefined>;
}

/**
 * The provisioned resources one stanza names — the evidence that separates "a stanza nobody deleted" from
 * "resources nobody can find any more".
 *
 * An id, never a value: these are Cloudflare identifiers an adopter's `wrangler.jsonc` already commits, so
 * naming them in a report costs nothing and is the only way the line is actionable. A binding with no id is
 * deliberately not counted — that is the not-yet-provisioned shape #241 asks `doctor` to read as *not
 * provisioned* rather than as broken.
 */
function provisionedResources(stanza: StanzaBindings): string[] {
  const found: string[] = [];
  for (const entry of stanza.d1_databases ?? []) if (entry.database_id) found.push(`d1 ${entry.database_id}`);
  for (const entry of stanza.kv_namespaces ?? []) if (entry.id) found.push(`kv ${entry.id}`);
  for (const entry of stanza.r2_buckets ?? []) if (entry.bucket_name) found.push(`r2 ${entry.bucket_name}`);
  for (const entry of stanza.vectorize ?? []) if (entry.index_name) found.push(`vectorize ${entry.index_name}`);
  return found;
}

/** The declared environment set, or `null` when the root config would not read or would not validate. */
async function declaredEnvironments(projectDir: string): Promise<string[] | null> {
  try {
    return [...loadProjectEnvironments(await loadProject(projectDir))];
  } catch {
    // `checkProjectName` and the `Project:` block already own "the config would not load". A second block
    // reporting it is how a report starts contradicting itself.
    return null;
  }
}

/** Compare every Worker's `env.<name>` stanzas against the project's declaration. */
export async function checkEnvironments(projectDir: string): Promise<EnvironmentsCheck> {
  const declared = await declaredEnvironments(projectDir);
  if (declared === null) return { state: "could-not-check", declared: [], drift: [] };

  let workers: WorkerTarget[];
  try {
    workers = await discoverWorkers(projectDir);
  } catch {
    return { state: "could-not-check", declared, drift: [] };
  }

  const drift: EnvironmentDrift[] = [];
  let unreadable = false;
  for (const target of workers) {
    // A process in the dev set with no `wrangler.jsonc` — a Vite frontend — declares no environments at
    // all, which is not a disagreement with anything.
    if (!target.hasWrangler) continue;
    let config: StanzaBindings;
    try {
      config = (await readWranglerConfig(target.dir)) as StanzaBindings;
    } catch {
      unreadable = true;
      continue;
    }
    const worker = basename(target.dir);
    const stanzas = Object.entries(config.env ?? {});
    for (const [env, stanza] of stanzas) {
      if (declared.includes(env)) continue;
      const resources = stanza ? provisionedResources(stanza) : [];
      drift.push({ worker, env, kind: resources.length > 0 ? "orphaned" : "undeclared", resources });
    }
    for (const env of declared) {
      if (stanzas.some(([name]) => name === env)) continue;
      drift.push({ worker, env, kind: "missing", resources: [] });
    }
  }

  if (drift.length > 0) return { state: "drifted", declared, drift };
  return { state: unreadable ? "could-not-check" : "ok", declared, drift: [] };
}

/**
 * One drift, as the sentence that fits it. Three faults, three remedies — and the orphan's remedy is
 * deliberately not "change it back and carry on": the resources are still there under the old name, and
 * only the adopter can say whether to adopt them or delete them.
 */
export function describeEnvironmentDrift(drift: EnvironmentDrift, declared: string[]): string {
  const set = declared.join(", ");
  if (drift.kind === "missing") {
    return `pithy.config.ts declares ${drift.env}, and this Worker has no env.${drift.env} stanza. Add one, or drop ${drift.env} from environments.`;
  }
  if (drift.kind === "undeclared") {
    return `env.${drift.env} is a stanza pithy.config.ts does not declare (${set}). Add ${drift.env} to environments, or remove the stanza.`;
  }
  return `env.${drift.env} holds provisioned resources and pithy.config.ts no longer declares it (${set}). Renaming an environment does not rename what it provisioned — those resources are orphaned. Restore ${drift.env} to environments, or delete them in Cloudflare and remove the stanza.`;
}
