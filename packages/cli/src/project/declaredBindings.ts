// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import type { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { FeatureResourceKind } from "@pithy-sh/core/src/naming/feature";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { type BindingDeclaration, resolveBindingNamings } from "../capabilities/bindingNamings";
import { provisionableBindings } from "../feature/bindings";
import { appendBinding, envStanzas, type WranglerStanza } from "./bindingEntries";
import { readWranglerConfig, writeWranglerConfig } from "./wrangler";

/**
 * **What `pithy worker sync` writes for the resources a Worker composes: every D1, KV, R2 and queue binding
 * `pithy provision` would create a resource for**, the app's own and every library capability's, after the Worker's
 * honored declines.
 *
 * Each entry goes through {@link appendBinding}, the writer `pithy add` and `pithy upgrade` use, so an entry this
 * writes is the entry they would. A binding a stanza already declares is left as the adopter has it.
 */

/** One binding the Worker composes, with the capability that answers for it. */
export interface DeclaredBinding {
  /** The capability whose `requiredBindings` declares it. */
  capability: Capability;
  /** The spec, with its manifest's `scope` and `resource` where the manifest states them. */
  spec: BindingSpec;
  /** The resource kind `pithy provision` creates for it. */
  kind: FeatureResourceKind;
}

/** One binding a stanza gained, or could not be given. */
export interface DeclaredBindingEntry {
  /** The binding name. */
  binding: string;
  /** Its kind. */
  type: FeatureResourceKind;
}

/** What one environment's stanza got. */
export interface DeclaredBindingRun {
  /** The environment: `dev` for the top-level stanza. */
  env: string;
  /** The bindings written into it. */
  written: DeclaredBindingEntry[];
  /** The bindings it lacks and could not be given, each with the writer's reason. */
  skipped: (DeclaredBindingEntry & { reason: string })[];
}

/**
 * The provisionable bindings `capabilities` compose, after `declined`, each once and from the first capability
 * declaring it: the set and order {@link provisionableBindings} gives `pithy provision`, with each binding's spec.
 */
export function declaredBindingSpecs(
  capabilities: readonly Capability[],
  declined: ReadonlySet<string> = new Set(),
): DeclaredBinding[] {
  const wanted = new Map(
    provisionableBindings(capabilities, declined).map((binding) => [binding.binding, binding.kind]),
  );
  const result: DeclaredBinding[] = [];
  for (const capability of capabilities) {
    for (const spec of capability.requiredBindings) {
      const kind = wanted.get(spec.name);
      if (kind === undefined) continue;
      wanted.delete(spec.name);
      result.push({ capability, spec, kind });
    }
  }
  return result;
}

/** Options for {@link reconcileDeclaredBindings}. */
export interface ReconcileDeclaredBindingsOptions {
  /** The Worker's directory: its basename is the owner segment of an owned binding's name. */
  workerDir: string;
  /** The project, from the root `pithy.config.ts`. Absent writes every entry that needs no name. */
  project?: string;
  /** What the Worker composes, libraries first and its app last. */
  capabilities: readonly Capability[];
  /** The Worker's composed manifests and its app's own instance: where a binding's `scope` and `resource` live. */
  declarations: readonly BindingDeclaration[];
  /** The binding names the Worker's honored declines leave out. */
  declined: ReadonlySet<string>;
  /** The Worker's `pithy.worker.jsonc` `ownBindings`. */
  ownBindings: readonly string[];
  /** Just this environment. Omitted, every stanza the config declares. */
  env?: string;
}

/** Overlay the manifest's naming onto each spec, so a binding is named the way `pithy provision` names it. */
function withNamings(
  bindings: readonly DeclaredBinding[],
  options: ReconcileDeclaredBindingsOptions,
): DeclaredBinding[] {
  if (options.project === undefined) return [...bindings];
  const namings = resolveBindingNamings({
    manifests: options.declarations,
    capabilities: new Set(options.capabilities.map((capability) => capability.name)),
    bindings: provisionableBindings(options.capabilities, options.declined),
    scope: environmentScope(options.project, LOCAL_ENVIRONMENT),
  });
  return bindings.map(({ capability, spec, kind }) => {
    const naming = namings.get(spec.name)?.naming ?? {};
    return {
      capability,
      kind,
      spec: {
        ...spec,
        ...(naming.scope === undefined ? {} : { scope: naming.scope }),
        ...(naming.resource === undefined ? {} : { resource: naming.resource }),
      },
    };
  });
}

/**
 * Write every binding the Worker composes into each stanza that lacks it, and say what each stanza got. The file is
 * written only when an entry was.
 */
export async function reconcileDeclaredBindings(
  options: ReconcileDeclaredBindingsOptions,
): Promise<DeclaredBindingRun[]> {
  const bindings = withNamings(declaredBindingSpecs(options.capabilities, options.declined), options);
  if (bindings.length === 0) return [];
  const config = (await readWranglerConfig(options.workerDir)) as WranglerStanza;
  const owns = { worker: basename(options.workerDir), bindings: new Set(options.ownBindings) };

  const runs: DeclaredBindingRun[] = [];
  for (const { env, stanza } of envStanzas(config)) {
    if (options.env !== undefined && env !== options.env) continue;
    const run: DeclaredBindingRun = { env, written: [], skipped: [] };
    for (const { capability, spec, kind } of bindings) {
      const write = appendBinding(stanza, spec, {
        ...(options.project === undefined ? {} : { project: options.project }),
        env,
        capability: capability.name,
        owns,
        topLevel: stanza === config,
        composed: capability,
      });
      if (write.outcome === "written") run.written.push({ binding: spec.name, type: kind });
      if (write.outcome === "skipped") run.skipped.push({ binding: spec.name, type: kind, reason: write.reason });
    }
    runs.push(run);
  }

  if (runs.some((run) => run.written.length > 0)) await writeWranglerConfig(options.workerDir, config);
  return runs;
}
