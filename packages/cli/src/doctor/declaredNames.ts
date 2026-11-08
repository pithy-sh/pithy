// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { remedy } from "@pithy-sh/core/src/cli/command";
import { GLOBAL_SCOPE } from "@pithy-sh/core/src/naming/environment";
import type { FeatureResourceKind } from "@pithy-sh/core/src/naming/feature";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { provisionableBindings } from "../feature/bindings";
import { resolveWorkersFor } from "../project/composeFor";
import { loadProject, loadProjectEnvironments, requireProjectName } from "../project/config";
import { readWranglerConfig } from "../project/wrangler";

/**
 * **Does each declared resource name say what `pithy provision` would name it, for that Worker?**
 *
 * A D1 `database_name`, an R2 `bucket_name` and a queue producer's `queue` are names a stanza states, and
 * `pithy provision` writes the name it composes over them: `<project>-<env>-<binding>` for a binding the Worker
 * shares, `<project>-<env>-<worker>---<binding>` for one it lists in `ownBindings`. A name that says anything else
 * is a stanza and a run that will disagree, and the one place the disagreement shows is the run that rewrites it.
 * So the finding is reported first, here, with both ways out: own the binding, or let provision repoint it.
 *
 * Report-only. It reads the files and the composition and writes nothing; a hand-chosen name may be the one the
 * adopter meant, until they say which. An `ownBindings` entry naming nothing the Worker composes is reported beside
 * it, as a stale `declinedBindings` entry is: it owns nothing.
 *
 * The declared environments only. The top-level stanza is local dev's, and `pithy worker sync` keeps its names.
 */

/** One stanza naming a resource other than the one provision would name for that Worker. */
export interface DeclaredNameMismatch {
  /** The `apps/<dir>` basename. */
  worker: string;
  /** The declared environment. */
  env: string;
  /** The binding. */
  binding: string;
  /** The kind of resource. */
  kind: Extract<FeatureResourceKind, "d1" | "r2" | "queue">;
  /** What the stanza names. */
  declared: string;
  /** What `pithy provision` composes for this Worker: owned when the binding is in its `ownBindings`. */
  expected: string;
  /** Whether the Worker owns the binding. */
  owned: boolean;
}

/** One `ownBindings` entry naming no D1, KV, R2 or queue binding the Worker composes. */
export interface UnrecognizedOwnBinding {
  /** The `apps/<dir>` basename. */
  worker: string;
  /** The entry, as written. */
  binding: string;
}

/** What `doctor` learned about declared resource names. */
export interface DeclaredNamesCheck {
  /** `ok`, `drifted` when anything below is non-empty, or `could-not-check`. */
  state: "ok" | "drifted" | "could-not-check";
  /** Every stanza naming another resource. */
  mismatches: DeclaredNameMismatch[];
  /** Every stale `ownBindings` entry. */
  unrecognized: UnrecognizedOwnBinding[];
}

/** A Worker as this check reads it. */
export interface DeclaredNamesWorker {
  /** Its directory. */
  dir: string;
  /** What it composes in the environment asked for. */
  capabilities: readonly Capability[];
  /** Its `pithy.worker.jsonc` `ownBindings`. */
  ownBindings: readonly string[];
}

/** The fields of one stanza this reads. */
interface NamedStanza {
  d1_databases?: { binding?: string; database_name?: string }[];
  r2_buckets?: { binding?: string; bucket_name?: string }[];
  queues?: { producers?: { binding?: string; queue?: string }[] };
}

/** Every `(kind, binding, name)` a stanza states. */
function declaredNames(stanza: NamedStanza): { kind: DeclaredNameMismatch["kind"]; binding: string; name: string }[] {
  const out: { kind: DeclaredNameMismatch["kind"]; binding: string; name: string }[] = [];
  for (const entry of stanza.d1_databases ?? []) {
    if (entry.binding && entry.database_name)
      out.push({ kind: "d1", binding: entry.binding, name: entry.database_name });
  }
  for (const entry of stanza.r2_buckets ?? []) {
    if (entry.binding && entry.bucket_name) out.push({ kind: "r2", binding: entry.binding, name: entry.bucket_name });
  }
  for (const entry of stanza.queues?.producers ?? []) {
    if (entry.binding && entry.queue) out.push({ kind: "queue", binding: entry.binding, name: entry.queue });
  }
  return out;
}

/** The real composition: every Worker under `apps/`, composed for `env`. */
async function resolveFor(projectDir: string, env: string): Promise<DeclaredNamesWorker[]> {
  return (await resolveWorkersFor(env, { projectDir })).map((worker) => ({
    dir: worker.dir,
    capabilities: worker.capabilities,
    ownBindings: worker.target.ownBindings ?? [],
  }));
}

/** Check every declared environment's stanzas. Never throws: a broken project gets `could-not-check`. */
export async function checkDeclaredNames(
  projectDir: string,
  resolve: (env: string) => Promise<DeclaredNamesWorker[]> = (env) => resolveFor(projectDir, env),
): Promise<DeclaredNamesCheck> {
  const empty = { mismatches: [], unrecognized: [] };
  let project: string;
  let environments: string[];
  try {
    const config = await loadProject(projectDir);
    project = requireProjectName(config);
    environments = [...loadProjectEnvironments(config)];
  } catch {
    return { state: "could-not-check", ...empty };
  }

  const mismatches: DeclaredNameMismatch[] = [];
  const unrecognized = new Map<string, UnrecognizedOwnBinding>();
  try {
    for (const env of environments) {
      const scope = environmentScope(project, env);
      for (const worker of await resolve(env)) {
        const app = basename(worker.dir);
        const provisionable = new Set(provisionableBindings(worker.capabilities).map((binding) => binding.binding));
        for (const binding of worker.ownBindings) {
          if (!provisionable.has(binding)) unrecognized.set(`${app}:${binding}`, { worker: app, binding });
        }
        let config: { env?: Record<string, NamedStanza | undefined> };
        try {
          config = (await readWranglerConfig(worker.dir)) as typeof config;
        } catch {
          continue;
        }
        const stanza = config.env?.[env];
        if (stanza === undefined) continue;
        for (const declared of declaredNames(stanza)) {
          const spec = worker.capabilities
            .flatMap((capability) => capability.requiredBindings)
            .find((candidate) => candidate.name === declared.binding && candidate.type === declared.kind);
          // A binding nothing composes is the adopter's own, and provision does not name it.
          if (spec === undefined) continue;
          const global = spec.scope === GLOBAL_SCOPE;
          const owned = !global && worker.ownBindings.includes(declared.binding);
          const naming = {
            ...(spec.scope ? { scope: spec.scope } : {}),
            ...(spec.resource ? { resource: spec.resource } : {}),
          };
          const expected = scope.resource(declared.binding, declared.kind, naming, owned ? app : undefined);
          if (expected === declared.name) continue;
          mismatches.push({
            worker: app,
            env,
            binding: declared.binding,
            kind: declared.kind,
            declared: declared.name,
            expected,
            owned,
          });
        }
      }
    }
  } catch {
    return { state: "could-not-check", ...empty };
  }
  const stale = [...unrecognized.values()];
  return { state: mismatches.length + stale.length > 0 ? "drifted" : "ok", mismatches, unrecognized: stale };
}

/** One mismatch in a sentence, with both ways out. */
export function describeDeclaredName(
  mismatch: DeclaredNameMismatch,
  productionEnvironments: readonly string[] = [],
): string {
  const repoint = remedy(
    "provision",
    { flags: { "--env": mismatch.env, "--yes": true, "--repoint": true } },
    { productionEnvironments },
  );
  const own = mismatch.owned
    ? ""
    : ` For a resource of this Worker's own, add ${mismatch.binding} to ownBindings in apps/${mismatch.worker}/pithy.worker.jsonc.`;
  return `${mismatch.env} names ${mismatch.binding} ${mismatch.declared}. Provisioning names it ${mismatch.expected}.${own} ${repoint.say((command) => `For provision's name, run ${command}.`)}`;
}

/** One stale `ownBindings` entry in a sentence. */
export function describeUnrecognizedOwnBinding(entry: UnrecognizedOwnBinding): string {
  return `ownBindings lists ${entry.binding}, which nothing this Worker composes declares as a D1, KV, R2 or queue binding. It owns nothing.`;
}
