// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { GLOBAL_SCOPE, isValidEnvironment } from "@pithy-sh/core/src/naming/environment";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
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

/** Reconcile `options.workerDir`'s D1 entries with its `ownBindings`, and say what changed. */
export async function reconcileOwnedDatabases(options: {
  /** The Worker's directory: its basename is the owner segment. */
  workerDir: string;
  /** The project, from the root `pithy.config.ts`. */
  project: string;
  /** The capabilities the Worker composes: what declares each D1 binding, and how it is named. */
  capabilities: readonly Capability[];
  /** The Worker's `pithy.worker.jsonc` `ownBindings`. */
  ownBindings: readonly string[];
  /** Only this environment's stanza, when one is named. */
  env?: string;
}): Promise<OwnedStanzaChange[]> {
  const config = (await readWranglerConfig(options.workerDir)) as WranglerStanza;
  const worker = basename(options.workerDir);
  const owned = new Set(options.ownBindings);
  const names = resourceNames(options.project);
  const specs = new Map<string, { capability: string; resource?: string; global: boolean }>();
  for (const capability of options.capabilities) {
    for (const spec of capability.requiredBindings) {
      if (spec.type !== "d1" || specs.has(spec.name)) continue;
      specs.set(spec.name, {
        capability: capability.name,
        ...(spec.resource ? { resource: spec.resource } : {}),
        global: spec.scope === GLOBAL_SCOPE,
      });
    }
  }
  for (const binding of owned) {
    const spec = specs.get(binding);
    if (spec?.global) {
      throw new ValidationError({
        message: `${worker} owns ${binding}, which ${spec.capability} declares global: one resource for the whole project.`,
        action: `Take ${binding} out of ownBindings in apps/${worker}/pithy.worker.jsonc.`,
      });
    }
  }

  const changes: OwnedStanzaChange[] = [];
  for (const { env, stanza } of envStanzas(config)) {
    if (options.env !== undefined && env !== options.env) continue;
    if (!isValidEnvironment(env)) continue;
    const topLevel = stanza === config;
    for (const entry of stanza.d1_databases ?? []) {
      const spec = specs.get(entry.binding);
      if (spec === undefined || spec.global) continue;
      const thing = spec.resource ?? entry.binding;
      const shared = names.env(env).d1(thing);
      const own = names.env(env).d1(thing, worker);
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
