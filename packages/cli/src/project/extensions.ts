// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";

/**
 * What an adopter plugged into a capability, read back for `pithy doctor`.
 *
 * A capability composed from a package has a name and a version the CLI can read off `package.json`,
 * and `Project capabilities:` reports it. Something an adopter passed *into* a capability's config has
 * neither — and it can still add routes to the Worker and tables to the database. A Better Auth plugin
 * (#271) is the first of these, and it will not be the last, so this reads the generic
 * `Capability.extensions` seam rather than knowing what a Better Auth plugin is. The CLI does not
 * depend on `@pithy-sh/auth`, and after this it still does not need to.
 *
 * Report-only, and offline: it names what is composed. It establishes no fault and never gates the
 * exit — a plugin an adopter deliberately added is not drift. The failure it exists to prevent is the
 * one where nothing anywhere says the plugin is there.
 */

/** One extension, and where it was found. */
export interface CapabilityExtensionEntry {
  /** The Worker whose `pithy.config.ts` composed it. */
  worker: string;
  /** The capability it was plugged into. */
  capability: string;
  /** The extension point, in that capability's vocabulary (e.g. `better-auth-plugin`). */
  kind: string;
  /** The extension's identity — what an adopter would go and delete. */
  id: string;
  /** The tables it introduced, if any. */
  tables: string[];
}

/** Every extension every Worker composes, in Worker then composition order. */
export interface ExtensionsCheck {
  extensions: CapabilityExtensionEntry[];
}

/** One Worker's name and the capabilities its own `pithy.config.ts` composes. */
export interface ExtensionScope {
  name: string;
  capabilities: Capability[];
}

/** Collect every composed extension across a project's Workers. */
export function checkExtensions(workers: readonly ExtensionScope[]): ExtensionsCheck {
  const extensions: CapabilityExtensionEntry[] = [];
  for (const worker of workers) {
    for (const capability of worker.capabilities) {
      for (const extension of capability.extensions ?? []) {
        extensions.push({
          worker: worker.name,
          capability: capability.name,
          kind: extension.kind,
          id: extension.id,
          tables: [...(extension.tables ?? [])],
        });
      }
    }
  }
  return { extensions };
}

/** One extension's line: what it is, and what it put in the database. */
export function describeExtension(entry: CapabilityExtensionEntry): string {
  const tables = entry.tables.length > 0 ? `tables ${entry.tables.join(", ")}` : "no tables";
  return `${entry.capability}: ${entry.id} (${entry.kind}), ${tables}.`;
}
