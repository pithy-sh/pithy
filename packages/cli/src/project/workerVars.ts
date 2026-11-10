// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { isWorkerVars, parseVar, varValueFor, type WorkerVar } from "@pithy-sh/core/src/worker/vars";
import { envStanzas, type WranglerStanza } from "./bindingEntries";
import type { WorkerConfig } from "./config";
import { setStanzaVar, stanzaVarsOf } from "./stanzaVars";
import { readWranglerConfig, writeWranglerConfig } from "./wrangler";

/**
 * **What `pithy worker sync` writes for the vars a Worker declares**: each one, into the top-level `vars` and every
 * `env.<name>.vars`, at that environment's value or the default. A value already in a stanza that parses under the
 * var's schema is the adopter's and stays; one that does not is reported and left as it is. A var nobody declared is
 * never touched.
 *
 * The one value in a stanza that is not the adopter's is a copy of the top level's, where the declaration gives that
 * environment a value of its own: every command that creates an `env.<name>` stanza seeds its `vars` from the top
 * level, so a new `env.prod` starts at dev's value. That one is rewritten to the environment's, by sync and by
 * provisioning, which writes the stanza it provisions, a feature's included, through {@link applyDeclaredVars}.
 */

/** One declared var, and who declared it: `pithy.config.ts` or a capability's name. */
export interface DeclaredWorkerVar {
  entry: WorkerVar;
  from: string;
}

/** What one stanza got. */
export interface WorkerVarRun {
  /** The environment: `dev` for the top-level stanza. */
  env: string;
  /** The vars written into it, each with the value written. */
  written: { name: string; value: unknown }[];
  /** The vars it holds a value for that the declaration refuses, each with that value and why. */
  invalid: { name: string; value: unknown; problem: string }[];
}

/** The source name a Worker's own declaration is reported under. */
export const WORKER_CONFIG_SOURCE = "pithy.config.ts";

/**
 * Every var a Worker declares: its `pithy.config.ts` `vars`, then each composed capability's, by name. Refuses a
 * `vars` not built with `defineVars`, and a name two sources declare.
 */
export function declaredWorkerVars(
  config: Pick<WorkerConfig, "vars">,
  capabilities: readonly Capability[],
): Map<string, DeclaredWorkerVar> {
  const sources: { from: string; vars: unknown }[] = [
    { from: WORKER_CONFIG_SOURCE, vars: config.vars },
    ...capabilities.map((capability) => ({ from: capability.name, vars: capability.vars })),
  ];
  const declared = new Map<string, DeclaredWorkerVar>();
  for (const { from, vars } of sources) {
    if (vars === undefined || vars === null) continue;
    if (!isWorkerVars(vars)) {
      throw new ValidationError({
        message: `The vars ${from === WORKER_CONFIG_SOURCE ? "this Worker's pithy.config.ts" : from} declares are not built with defineVars.`,
        action: "Build `vars` with defineVars, from @pithy-sh/core/src/worker/vars.",
      });
    }
    for (const [name, entry] of Object.entries(vars.vars)) {
      const earlier = declared.get(name);
      if (earlier !== undefined) {
        throw new ValidationError({
          message: `The var ${name} is declared twice: by ${earlier.from} and by ${from}.`,
          action: "Declare each var once. Rename one, or take it out of the Worker's own vars.",
        });
      }
      declared.set(name, { entry, from });
    }
  }
  return declared;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether `held`, a stanza's value for a declared var, is the top level's value carried down rather than one someone
 * chose: the declaration gives `env` a value of its own, the stanza holds the top level's value instead, and the two
 * differ. Never true of the top level itself, or of a var whose every environment takes the same value.
 */
export function copiedFromTopLevel(entry: WorkerVar, env: string, held: unknown, top: unknown): boolean {
  if (env === LOCAL_ENVIRONMENT) return false;
  const own = varValueFor(entry, env);
  if (sameValue(own, varValueFor(entry, LOCAL_ENVIRONMENT))) return false;
  return held !== undefined && sameValue(held, top) && !sameValue(held, own);
}

/** Options for {@link reconcileWorkerVars}. */
export interface ReconcileWorkerVarsOptions {
  /** The Worker's directory. */
  workerDir: string;
  /** What {@link declaredWorkerVars} returned. */
  declared: ReadonlyMap<string, DeclaredWorkerVar>;
  /** Just this environment. Omitted, every stanza the config declares. */
  env?: string;
}

/**
 * Write every declared var into one stanza, in place: each it lacks, or holds only as the top level's copy, at
 * `env`'s value. `top` is the config's top level, the stanza itself for `dev`. Every writer of a stanza's declared
 * vars comes through here: `pithy worker sync` for each tracked stanza, and provisioning for the stanza it writes,
 * a feature's generated one included.
 */
export function applyDeclaredVars(
  stanza: object,
  env: string,
  declared: ReadonlyMap<string, DeclaredWorkerVar>,
  top: object,
): WorkerVarRun {
  const topVars = stanzaVarsOf(top) ?? {};
  const run: WorkerVarRun = { env, written: [], invalid: [] };
  for (const [name, { entry }] of declared) {
    const held = stanzaVarsOf(stanza) ?? {};
    const topValue = Object.hasOwn(topVars, name) ? topVars[name] : undefined;
    if (Object.hasOwn(held, name) && !copiedFromTopLevel(entry, env, held[name], topValue)) {
      const parsed = parseVar(entry, held[name]);
      if (!parsed.ok) run.invalid.push({ name, value: held[name], problem: parsed.problem });
      continue;
    }
    const value = varValueFor(entry, env);
    setStanzaVar(stanza, name, value);
    run.written.push({ name, value });
  }
  return run;
}

/** Write every declared var into each stanza that lacks it, and say what each stanza got. Writes only on a change. */
export async function reconcileWorkerVars(options: ReconcileWorkerVarsOptions): Promise<WorkerVarRun[]> {
  if (options.declared.size === 0) return [];
  const config = (await readWranglerConfig(options.workerDir)) as WranglerStanza;
  const runs: WorkerVarRun[] = [];
  for (const { env, stanza } of envStanzas(config)) {
    if (options.env !== undefined && env !== options.env) continue;
    runs.push(applyDeclaredVars(stanza, env, options.declared, config));
  }
  if (runs.some((run) => run.written.length > 0)) await writeWranglerConfig(options.workerDir, config);
  return runs;
}
