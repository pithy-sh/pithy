// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingType } from "@pithy-sh/core/src/capability/bindings";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { FeatureResourceKind } from "@pithy-sh/core/src/naming/feature";

/**
 * A single Cloudflare resource `pithy provision --feature` stands up: the Worker binding it backs and the
 * kind of resource that binding needs. Derived purely from the composed capabilities' `requiredBindings`
 * — no hand-maintained list — so enabling a capability automatically brings its resources into the set.
 */
export interface ProvisionableBinding {
  /** The Worker binding name (e.g. "DB", "SESSIONS", "ASSETS"). */
  binding: string;
  /** The provisionable resource kind this binding needs. */
  kind: FeatureResourceKind;
}

/**
 * The subset of {@link BindingType}s `pithy feature` provisions as standalone, per-feature resources.
 * D1 databases, KV namespaces, and R2 buckets each get their own ephemeral resource. Every other
 * binding kind is either account-scoped (`ai`), wired in config rather than provisioned (`durable_object`,
 * `service`, `workflow`, `queue`), or owned by another capability's provisioner (`secret`, `email`) — so
 * `provision` skips them. Extend this map (and the CF provisioners) to grow the provisionable set.
 */
const PROVISIONABLE: Partial<Record<BindingType, FeatureResourceKind>> = {
  d1: "d1",
  kv: "kv",
  r2: "r2",
};

/**
 * The provisionable resources for a set of enabled capabilities: every `d1`/`kv`/`r2` binding they
 * declare, deduplicated by binding name (two capabilities may share one binding — one resource backs it),
 * in a stable order. Non-provisionable binding kinds are dropped. This is the auto-discovered set
 * `provision` creates one CF resource per and `destroy` reconciles against.
 */
/** A worker-to-worker RPC binding: the env name it appears under, and the Worker it calls. */
export interface ServiceBinding {
  /** The binding name in the Worker env (e.g. "API"). */
  binding: string;
  /** The target Worker, as named in `apps/<name>/`. */
  target: string;
}

/**
 * Every `service` binding the enabled capabilities declare, deduplicated by binding name. These are not
 * provisioned — the target Worker is deployed, not created — but each one must be *rewritten per
 * environment*: in a feature environment the binding has to point at that feature's own deployment of the
 * target, not at production's. `provision` resolves each target to its environment-scoped script name.
 */
export function serviceBindings(capabilities: Capability[]): ServiceBinding[] {
  const seen = new Set<string>();
  const result: ServiceBinding[] = [];
  for (const capability of capabilities) {
    for (const spec of capability.requiredBindings) {
      // `service` is guaranteed by BindingSpec's check; the guard keeps this total for a hand-built spec.
      if (spec.type !== "service" || !spec.service || seen.has(spec.name)) continue;
      seen.add(spec.name);
      result.push({ binding: spec.name, target: spec.service });
    }
  }
  return result;
}

export function provisionableBindings(capabilities: Capability[]): ProvisionableBinding[] {
  const seen = new Set<string>();
  const result: ProvisionableBinding[] = [];
  for (const capability of capabilities) {
    for (const spec of capability.requiredBindings) {
      const kind = PROVISIONABLE[spec.type];
      if (!kind || seen.has(spec.name)) continue;
      seen.add(spec.name);
      result.push({ binding: spec.name, kind });
    }
  }
  return result;
}
