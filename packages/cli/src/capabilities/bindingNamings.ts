// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { BindingNaming, ProvisionScope } from "@pithy-sh/core/src/naming/provisionScope";
import type { ProvisionableBinding } from "../feature/bindings";

/**
 * **A binding's `scope` and `resource` are declared in its capability's `pithy.manifest.json`, and read here.**
 *
 * The composed capability objects do not carry them, so a command that reads them off `requiredBindings` names a
 * global resource per environment. `pithy provision`, `pithy doctor` and `pithy worker sync` all name a binding
 * through {@link resolveBindingNamings}, over {@link bindingDeclarations}, so the three cannot disagree.
 */

/** Who declares a set of bindings: a capability's manifest, or a Worker's own app, which has none. */
export type BindingDeclaration = Pick<CapabilityManifest, "name" | "requiredBindings">;

/** One binding's declared naming, and who declared it — everything a refusal below needs to name. */
export interface DeclaredNaming {
  /** The manifest that declared it. */
  capability: string;
  /** What it says about the resource's name: `BindingSpec.scope` and `BindingSpec.resource`. */
  naming: BindingNaming;
  /** What that composes to in this scope — the string two declarations must agree on. */
  name: string;
}

/**
 * **What each binding's resource is called, from the manifests — and the two things that must be true
 * before a run creates anything.**
 *
 * An environment provisions **one resource per binding name**: that is how two Workers share a database,
 * and it is what makes the binding name the resource's identity. `scope` and `resource` are the first
 * fields that can break that identity from either end, so both ends are checked here, once, before the
 * first Cloudflare call — a refusal after the third resource is created is a half-provisioned account.
 *
 * The manifests are the source — and the Worker's own app, whose composed instance is its declaration —
 * and only for capabilities this environment actually composes.
 * Something installed under `node_modules` that no Worker composes declares nothing about this run, and a
 * binding no Worker will provision cannot collide with one that will — so a project is never refused for
 * a conflict it could not reach.
 */
export function resolveBindingNamings(options: {
  /** Every composed Worker's manifests, as read from its own `node_modules` and the root's, and its app's own. */
  manifests: readonly BindingDeclaration[];
  /** The capability names this environment composes — manifests outside it are not this run's business. */
  capabilities: ReadonlySet<string>;
  /** The bindings this run will provision, after declines. Nothing outside it can collide with anything. */
  bindings: readonly ProvisionableBinding[];
  /** The scope every name is composed in. Two declarations disagree when their *composed names* differ. */
  scope: ProvisionScope;
}): Map<string, DeclaredNaming> {
  const kinds = new Map(options.bindings.map((binding) => [binding.binding, binding.kind]));
  const byBinding = new Map<string, DeclaredNaming>();
  for (const manifest of options.manifests) {
    if (!options.capabilities.has(manifest.name)) continue;
    for (const spec of manifest.requiredBindings) {
      const kind = kinds.get(spec.name);
      if (kind === undefined) continue;
      const naming: BindingNaming = {
        ...(spec.scope ? { scope: spec.scope } : {}),
        ...(spec.resource ? { resource: spec.resource } : {}),
      };
      const declaredNaming: DeclaredNaming = {
        capability: manifest.name,
        naming,
        name: options.scope.resource(spec.name, kind, naming),
      };
      const seen = byBinding.get(spec.name);
      if (seen === undefined) {
        byBinding.set(spec.name, declaredNaming);
        continue;
      }
      if (seen.name === declaredNaming.name) continue;
      // **First-wins would let `readdir` order decide where a project's data lives.** Two capabilities
      // declaring one binding name are declaring one resource — the environment creates exactly one — so
      // a disagreement about its `scope` or its `resource` is a disagreement about *which* resource, and
      // whichever manifest happened to be read second would silently lose. The composed names are what
      // the refusal states, because they are the two things that cannot both be true.
      throw new ValidationError({
        message: `Two capabilities disagree about the resource behind "${spec.name}": ${seen.capability} names it ${seen.name}, ${manifest.name} names it ${declaredNaming.name}.`,
        action: `One binding name is one resource. Have ${seen.capability} and ${manifest.name} declare the same scope and resource for ${spec.name}, or give one of them a binding name of its own.`,
      });
    }
  }

  // **The other end, and nothing else would catch it.** `resource` is what removes the property that made
  // the binding name unique — two different bindings may now compose one name, and a run would create one
  // resource, adopt it on the second pass, and hand two capabilities a store each believes is its own.
  // Grouped per kind, because Cloudflare's namespaces are per kind: a D1 database and an R2 bucket of one
  // name are two resources, and refusing that pair would refuse a project that is fine.
  const byName = new Map<string, { binding: string; declaredNaming: DeclaredNaming }>();
  for (const [binding, declaredNaming] of byBinding) {
    const key = `${kinds.get(binding)}:${declaredNaming.name}`;
    const seen = byName.get(key);
    if (seen === undefined) {
      byName.set(key, { binding, declaredNaming });
      continue;
    }
    throw new ValidationError({
      message: `${seen.declaredNaming.capability}'s ${seen.binding} and ${declaredNaming.capability}'s ${binding} both name ${declaredNaming.name}.`,
      action: `Two bindings backed by one resource is a resource neither owns. Change the resource on one of them, or have them share a binding name if they mean to share the resource.`,
    });
  }
  return byBinding;
}

/**
 * Every declaration one Worker names its bindings from: its composed manifests, and its own app's composed
 * instance, which ships no manifest. A manifest of the app's name is the capability's, and wins.
 */
export function bindingDeclarations(
  manifests: readonly BindingDeclaration[],
  app: Pick<Capability, "name" | "requiredBindings"> | undefined,
): BindingDeclaration[] {
  if (app === undefined || manifests.some((manifest) => manifest.name === app.name)) return [...manifests];
  return [...manifests, { name: app.name, requiredBindings: app.requiredBindings }];
}
