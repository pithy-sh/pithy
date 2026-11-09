// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { GLOBAL_SCOPE, isValidEnvironment, LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { type BindingNaming, environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { type BindingDeclaration, resolveBindingNamings } from "../capabilities/bindingNamings";
import { provisionableBindings } from "../feature/bindings";
import { isAddressable } from "../provision/repoint";
import { envStanzas, type WranglerStanza } from "./bindingEntries";
import { readWranglerConfig, writeWranglerConfig } from "./wrangler";

/**
 * **What `pithy worker sync` makes a Worker's D1 entries say about `ownBindings`.**
 *
 * A binding listed after its entries were written still names the shared database, and one taken out still names
 * the Worker's own. So each entry naming the other one of the pair is rewritten: the `database_name` to the name
 * `pithy provision` composes for this Worker, and, in the top-level stanza that is local dev's, the `database_id`
 * that gives an owned database its own Miniflare store.
 *
 * A binding's `scope` and `resource` come from its manifest, through the resolution `pithy provision` uses. A
 * `global` binding is one resource for the project: it is never rewritten, and owning one is refused.
 *
 * **Only names the kit composed are rewritten.** An entry naming anything else is the adopter's, and `pithy doctor`
 * reports it. And an environment stanza that already holds a real `database_id` is left for
 * `pithy provision --repoint`: renaming it here would point a provisioned binding's name at one database and its id
 * at another.
 */

/** One field one entry changed. */
export interface OwnedStanzaChange {
  /** The environment: `dev` for the top-level stanza. */
  env: string;
  /** The binding. */
  binding: string;
  /** The field written or removed. */
  field: "database_name" | "database_id";
  /** What it said before, absent when the field was not there. */
  from?: string;
  /** What it says now, absent when the field was removed. */
  to?: string;
}

/** What names a Worker's bindings, and which of them it lists as its own. */
export interface OwnedBindingsInput {
  /** The Worker's directory: its basename is the owner segment. */
  workerDir: string;
  /** The project, from the root `pithy.config.ts`. */
  project: string;
  /** The capabilities the Worker composes: what declares each binding. */
  capabilities: readonly Capability[];
  /** The Worker's composed manifests and its app's own instance: how each binding is named. */
  declarations: readonly BindingDeclaration[];
  /** The Worker's `pithy.worker.jsonc` `ownBindings`. */
  ownBindings: readonly string[];
}

/** One composed binding: its kind, the capability that answers for it, its naming, and whether it is global. */
interface OwnedBindingSpec {
  type: string;
  capability: string;
  naming: BindingNaming;
  global: boolean;
}

/** Every binding the Worker composes, of every kind, by name. */
function bindingSpecs(options: OwnedBindingsInput): Map<string, OwnedBindingSpec> {
  const namings = resolveBindingNamings({
    manifests: options.declarations,
    capabilities: new Set(options.capabilities.map((capability) => capability.name)),
    bindings: provisionableBindings(options.capabilities),
    scope: environmentScope(options.project, LOCAL_ENVIRONMENT),
  });
  const specs = new Map<string, OwnedBindingSpec>();
  for (const capability of options.capabilities) {
    for (const spec of capability.requiredBindings) {
      if (specs.has(spec.name)) continue;
      const declared = namings.get(spec.name);
      const naming = declared?.naming ?? {};
      // The manifest's declaration, else the composed instance's: either one saying `global` makes it global.
      const global = naming.scope === GLOBAL_SCOPE || spec.scope === GLOBAL_SCOPE;
      specs.set(spec.name, {
        type: spec.type,
        capability: declared?.naming.scope === GLOBAL_SCOPE ? declared.capability : capability.name,
        naming,
        global,
      });
    }
  }
  return specs;
}

function refuse(worker: string, owned: Iterable<string>, specs: Map<string, OwnedBindingSpec>): void {
  for (const binding of owned) {
    const spec = specs.get(binding);
    if (spec?.global) {
      throw new ValidationError({
        message: `${worker} owns ${binding}, which ${spec.capability} declares global: one resource for the whole project.`,
        action: `Take ${binding} out of ownBindings in apps/${worker}/pithy.worker.jsonc.`,
      });
    }
  }
}

/**
 * Throw when `ownBindings` lists a global binding of any kind, D1 or not. It reads no file, so a command that
 * writes anything else into `wrangler.jsonc` asks it first and writes nothing when it throws.
 */
export function refuseOwnedGlobals(options: OwnedBindingsInput): void {
  refuse(basename(options.workerDir), options.ownBindings, bindingSpecs(options));
}

/**
 * Reconcile `options.workerDir`'s D1 entries with its `ownBindings`, and say what changed. A global binding of any
 * kind in `ownBindings` is refused before anything is written.
 */
export async function reconcileOwnedDatabases(
  options: OwnedBindingsInput & {
    /** Only this environment's stanza, when one is named. */
    env?: string;
  },
): Promise<OwnedStanzaChange[]> {
  const worker = basename(options.workerDir);
  const owned = new Set(options.ownBindings);
  const specs = bindingSpecs(options);
  refuse(worker, owned, specs);
  const config = (await readWranglerConfig(options.workerDir)) as WranglerStanza;

  const changes: OwnedStanzaChange[] = [];
  for (const { env, stanza } of envStanzas(config)) {
    if (options.env !== undefined && env !== options.env) continue;
    if (!isValidEnvironment(env)) continue;
    const topLevel = stanza === config;
    for (const entry of stanza.d1_databases ?? []) {
      const spec = specs.get(entry.binding);
      if (spec === undefined || spec.type !== "d1" || spec.global) continue;
      const scope = environmentScope(options.project, env);
      const shared = scope.resource(entry.binding, "d1", spec.naming);
      const own = scope.resource(entry.binding, "d1", spec.naming, worker);
      const isOwned = owned.has(entry.binding);
      const want = isOwned ? own : shared;
      const other = isOwned ? shared : own;
      if (entry.database_name === other && (topLevel || !isAddressable(entry.database_id))) {
        changes.push({ env, binding: entry.binding, field: "database_name", from: other, to: want });
        entry.database_name = want;
      }
      if (!topLevel) continue;
      if (isOwned && entry.database_id === undefined) {
        changes.push({ env, binding: entry.binding, field: "database_id", to: own });
        entry.database_id = own;
      } else if (!isOwned && entry.database_id === own) {
        changes.push({ env, binding: entry.binding, field: "database_id", from: own });
        delete entry.database_id;
      }
    }
  }
  if (changes.length > 0) await writeWranglerConfig(options.workerDir, config);
  return changes;
}
