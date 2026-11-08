// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { FeatureResourceKind } from "@pithy-sh/core/src/naming/feature";
import { provisionableBindings } from "./bindings";

/** One binding one Worker owns: the `apps/<app>` owner, the binding, and the kind of resource behind it. */
export interface OwnedBinding {
  /** The owning Worker's `apps/<app>` directory basename — the owner segment of the resource's name. */
  app: string;
  /** The binding. */
  binding: string;
  /** The kind of resource. */
  kind: FeatureResourceKind;
}

/** A Worker as ownership reads it: where it lives, what it lists, and what it composes. */
export interface OwningWorker {
  /** The Worker's directory. */
  dir: string;
  /** Its `pithy.worker.jsonc` `ownBindings`. */
  ownBindings?: readonly string[];
  /** The capabilities its owned bindings are looked up in. */
  capabilities: readonly Capability[];
}

/**
 * Every provisionable binding a Worker owns, across `workers`: an `ownBindings` entry naming a D1, KV, R2 or queue
 * binding the Worker's capabilities declare. Declines are not read: a teardown scans the whole declared set.
 */
export function ownedBindingsOf(workers: readonly OwningWorker[]): OwnedBinding[] {
  const out: OwnedBinding[] = [];
  for (const worker of workers) {
    const listed = new Set(worker.ownBindings ?? []);
    if (listed.size === 0) continue;
    for (const { binding, kind } of provisionableBindings(worker.capabilities)) {
      if (listed.has(binding)) out.push({ app: basename(worker.dir), binding, kind });
    }
  }
  return out;
}
