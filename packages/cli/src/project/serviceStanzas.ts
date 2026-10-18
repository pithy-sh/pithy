// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT, LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { workflowHostName } from "@pithy-sh/core/src/workflow/naming";
import { stringify } from "comment-json";
import { hostWorkerFor } from "../capabilities/hostRegistry";
import type { ServiceDeclaration } from "./configBindingSource";
import { readWranglerConfig, writeWranglerConfig } from "./wrangler";
import { stanzaFor } from "./wranglerInheritance";

/**
 * **Write an app's declared service bindings into every stanza of its `wrangler.jsonc` (#617).**
 *
 * A service binding names a *script*, and a script is per environment: `app-b` deploys as `acme-app-b` in dev,
 * `acme-staging-app-b` in staging, and the email host as `acme-prod-email` in prod. So the declaration in
 * `pithy.config.ts` names the Worker, and this writes, per stanza, the script that Worker deploys as there —
 * read from the target's own `wrangler.jsonc` where it states one, composed by the environment's scope where it
 * does not, exactly as `pithy provision` resolves a capability's service binding. A feature's stanza is
 * `pithy provision --feature`'s to write, into the generated config, and is never touched here.
 *
 * Upserted by binding name and never pruned: a `services` entry the adopter wrote by hand is theirs. The one
 * removal is the one asked for, `pithy worker unbind`'s, by name.
 */

/** One Worker of the project, by both of its names, and where it lives. */
export interface ServiceWorkerNames {
  /** Its `apps/<app>` directory name — what a service binding targets it by. */
  app: string;
  /** Its directory. */
  dir: string;
  /** Its deploy name, the top-level `name` of its `wrangler.jsonc`. */
  deployedAs: string;
}

/** The script a target deploys as in one environment, `dev` being the top level. */
export type ScriptResolver = (target: string, env: string) => string;

/**
 * The script each of the project's Workers, and each kit Worker, deploys as per environment. Reads each app
 * Worker's `wrangler.jsonc` once, for the names it declares. A target that is neither is refused, naming what is.
 */
export async function serviceScripts(project: string, workers: readonly ServiceWorkerNames[]): Promise<ScriptResolver> {
  const declared = new Map<string, Record<string, string | undefined>>();
  for (const worker of workers) {
    try {
      const config = (await readWranglerConfig(worker.dir)) as { env?: Record<string, { name?: string } | undefined> };
      declared.set(
        worker.app,
        Object.fromEntries(Object.entries(config.env ?? {}).map(([env, stanza]) => [env, stanza?.name])),
      );
    } catch {
      declared.set(worker.app, {});
    }
  }
  return (target, env) => {
    const worker = workers.find((candidate) => candidate.app === target);
    if (worker) {
      if (env === LOCAL_ENVIRONMENT) return worker.deployedAs;
      return environmentScope(project, env).worker(
        { app: worker.app, script: worker.deployedAs },
        declared.get(worker.app)?.[env],
      );
    }
    if (hostWorkerFor(target))
      return workflowHostName({ ...environmentScope(project, env).workflowHost, capability: target });
    throw new ValidationError({
      message: `A service binding targets "${target}", which is not one of this project's Workers.`,
      action: `Name an apps/ Worker or a kit Worker. Known: ${workers.map((candidate) => candidate.app).join(", ") || "none"}.`,
    });
  };
}

/** One `services` entry. */
interface ServiceEntry {
  binding: string;
  service: string;
}

/** What one stanza ended up with. */
export interface ServiceStanzaRun {
  /** The environment — `dev` for the top level. */
  env: string;
  /** The entries this Worker's declarations wrote there. */
  services: ServiceEntry[];
  /** Whether the stanza changed. */
  changed: boolean;
}

/** Options for {@link reconcileServiceStanzas}. */
export interface ReconcileServiceStanzasOptions {
  /** The binding Worker's directory. Its `wrangler.jsonc` is the file edited. */
  workerDir: string;
  /** Every service binding its app declares. */
  services: readonly ServiceDeclaration[];
  /** The script each target deploys as, per environment. */
  scripts: ScriptResolver;
  /** One environment only, or every stanza the file has when omitted. */
  env?: string;
  /** Binding names to take out of every stanza — `pithy worker unbind`'s. */
  remove?: readonly string[];
}

/** The stanzas this reconciles: the top level, and every declared environment the file carries. */
function environmentsOf(config: { env?: Record<string, unknown> }, env: string | undefined): string[] {
  if (env !== undefined) return env === FEATURE_ENVIRONMENT ? [] : [env];
  return [LOCAL_ENVIRONMENT, ...Object.keys(config.env ?? {}).filter((name) => name !== FEATURE_ENVIRONMENT)];
}

/**
 * Upsert every declared service binding into each stanza, at the script its target deploys as there, and take
 * out the ones named in `remove`. Comment-preserving, idempotent, and the file is written only when it changed.
 */
export async function reconcileServiceStanzas(options: ReconcileServiceStanzasOptions): Promise<ServiceStanzaRun[]> {
  const config = (await readWranglerConfig(options.workerDir)) as { env?: Record<string, unknown> };
  const before = stringify(config);
  const removed = new Set(options.remove ?? []);
  const runs: ServiceStanzaRun[] = [];
  for (const env of environmentsOf(config, options.env)) {
    const stanza = stanzaFor(config, env) as { services?: ServiceEntry[] };
    const stanzaBefore = stringify(stanza);
    const entries = options.services.map((declaration) => ({
      binding: declaration.binding,
      service: options.scripts(declaration.target, env),
    }));
    if (stanza.services && removed.size > 0) {
      // In place, so comment-json keeps the array's comments.
      const kept = stanza.services.filter((entry) => !removed.has(entry.binding));
      stanza.services.length = 0;
      stanza.services.push(...kept);
    }
    for (const entry of entries) {
      stanza.services ??= [];
      const existing = stanza.services.find((candidate) => candidate.binding === entry.binding);
      if (existing) existing.service = entry.service;
      else stanza.services.push({ ...entry });
    }
    runs.push({ env, services: entries, changed: stringify(stanza) !== stanzaBefore });
  }
  if (stringify(config) !== before) await writeWranglerConfig(options.workerDir, config);
  return runs;
}
