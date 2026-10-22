// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { z } from "zod";
import type { Capability } from "../capability/capability";
import { BUILT_IN_PRIVACY_CLASSES } from "./classes";
import { classifyPrivacy, type PrivacyField } from "./classify";
import { PRIVACY_SOURCES, type PrivacyInventory, type PrivacyInventorySchema } from "./report";

/**
 * **What this Worker holds, derived from the code that is running** (#132).
 *
 * The inventory is computed at runtime from the composed capabilities' storage schemas — the Zod objects that
 * *are* the table definitions, already in the deployed bundle — not stamped at build. A stamped artifact is
 * skippable (a raw `wrangler deploy` ships the last stamp) and a drifted one is worse than none, because a
 * dashboard acts on it. A derivation cannot be skipped, cannot be edited out of the adopter's repository, and
 * cannot disagree with the code: it is the code. Unmark a `phi()` field and that field leaves the report on the
 * next deploy, with no build step, generated file or person in between.
 *
 * ## What it walks
 *
 * {@link PRIVACY_SOURCES}, and nothing else: every composed capability's **D1 tables**, and its **KV stores** —
 * the key segments, the value and the metadata, since a KV entry stores all three. That is where persisted data
 * lives and what an auditor asks about. R2 objects, Vectorize metadata, Durable Object storage, email templates
 * and request bodies are not walked, and the report names its sources so that is a stated fact rather than an
 * implied guarantee.
 *
 * ## What a path looks like
 *
 * A D1 field is its column path: `email`, `address.line1`, or `profile.phone` for a marked field inside a JSON column,
 * which `redact` reads field by field. A KV field leads with the part of the entry it is in: `key.email`, `value.token`,
 * `metadata.ip`, `value[].email` for an array value — or `value` alone when the whole value is marked. It is the path
 * `pithy privacy scan` writes for the same field.
 *
 * ## The per-field record
 *
 * `{ path, class }`, from `classifyPrivacy`, with `truncated: true` where a read ran out of its budget and it assumed
 * every class, and `sameAs` on a reference: a position written out under another path once the list reached its cap
 * on paths, listed once per class marked beneath it. The counts count each record, a reference included. A value
 * `redact` cuts off at the recursion limit is masked `[truncated]`, a safety cutoff rather than a privacy class, so
 * it is not listed. It is the extension point #390 builds on: once a field can be marked encrypted at rest, that lands beside
 * `class` on this record, and "which of your PHI fields are encrypted" becomes one more derivation rather than a
 * second thing to maintain.
 *
 * ## What it costs
 *
 * Nothing until it is read. {@link lazyPrivacyInventory} walks on first read and caches for the isolate, so a
 * Worker whose control plane is never called never walks.
 */

/** The marked fields of a KV store: its key segments, value and metadata, each under its own prefix. */
function kvFields(store: { key: z.ZodType; value: z.ZodType; metadata?: z.ZodType }): PrivacyField[] {
  const parts: [string, z.ZodType | undefined][] = [
    ["key", store.key],
    ["value", store.value],
    ["metadata", store.metadata],
  ];
  return parts.flatMap(([part, schema]) =>
    schema
      ? classifyPrivacy(schema).map((field) => ({
          ...field,
          path: field.path === "" || field.path.startsWith("[") ? `${part}${field.path}` : `${part}.${field.path}`,
        }))
      : [],
  );
}

/** Classes in the order every report lists them: the built-ins first, then each other class by name. */
function ordered(classes: Iterable<string>): string[] {
  const builtIn: readonly string[] = BUILT_IN_PRIVACY_CLASSES;
  const all = [...new Set(classes)];
  return [...builtIn.filter((name) => all.includes(name)), ...all.filter((name) => !builtIn.includes(name)).sort()];
}

/** Walk every composed capability's D1 tables and KV stores. See the module note for exactly what is covered. */
export function privacyInventory(capabilities: readonly Capability[]): PrivacyInventory {
  const schemas: PrivacyInventorySchema[] = [];
  let schemasWalked = 0;
  for (const capability of capabilities) {
    for (const [container, database] of Object.entries(capability.databases ?? {})) {
      for (const [name, table] of Object.entries(database.tables)) {
        schemasWalked += 1;
        const fields = classifyPrivacy(table as z.ZodType);
        if (fields.length > 0) schemas.push({ capability: capability.name, storage: "d1", container, name, fields });
      }
    }
    for (const [container, namespace] of Object.entries(capability.kvNamespaces ?? {})) {
      for (const [name, store] of Object.entries(namespace.stores)) {
        schemasWalked += 1;
        const fields = kvFields(store);
        if (fields.length > 0) schemas.push({ capability: capability.name, storage: "kv", container, name, fields });
      }
    }
  }
  const tally = new Map<string, number>();
  for (const schema of schemas)
    for (const field of schema.fields) tally.set(field.class, (tally.get(field.class) ?? 0) + 1);
  const observed = ordered(tally.keys());
  const counts = Object.fromEntries(observed.map((name) => [name, tally.get(name) ?? 0]));
  return { sources: [...PRIVACY_SOURCES], schemasWalked, schemas, counts, observed };
}

/**
 * The inventory, walked on first read and cached for the isolate. `capabilities` is a thunk because the
 * composed set is only known once assembly has run, and reading it is itself deferred to the first call.
 */
export function lazyPrivacyInventory(capabilities: () => readonly Capability[]): () => PrivacyInventory {
  let cached: PrivacyInventory | undefined;
  return () => {
    cached ??= privacyInventory(capabilities());
    return cached;
  };
}
