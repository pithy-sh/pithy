// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readWranglerConfig } from "../project/wrangler";

/**
 * Every variable name one Worker's `wrangler.jsonc` declares — the top-level `vars` block **and** every
 * `env.<name>.vars`.
 *
 * **`env.<name>.vars` REPLACES the top-level block rather than merging it**, which is the gotcha the
 * starter's own `wrangler.jsonc` comment warns about: every environment repeats every variable. So a
 * name counts as declared if it appears at the top level **or** in any environment — reading only the
 * top level names a staging-only variable as undeclared, and reading only one environment names every
 * ordinary variable as undeclared.
 *
 * **It lives here rather than in either caller.** Two doctor checks ask this question — what a
 * `.dev.vars.local` key has behind it, and what a root `.dev.vars` key has behind it — and a rule this
 * easy to get half-right is a rule that must exist once. An unreadable or absent config declares
 * nothing, which is the honest answer: the health block is where a `wrangler.jsonc` that will not parse
 * gets said, and louder.
 */
export async function declaredVars(workerDir: string): Promise<Set<string>> {
  const config = (await readWranglerConfig(workerDir).catch(() => null)) as {
    vars?: Record<string, unknown>;
    env?: Record<string, { vars?: Record<string, unknown> } | undefined>;
  } | null;
  const keys = new Set<string>();
  for (const key of Object.keys(config?.vars ?? {})) keys.add(key);
  for (const environment of Object.values(config?.env ?? {})) {
    for (const key of Object.keys(environment?.vars ?? {})) keys.add(key);
  }
  return keys;
}

/**
 * The top-level keys that are maps of names to values rather than bindings. `vars` is
 * {@link declaredVars}' question; `define` is a build-time substitution. A var named `binding` is a
 * variable, so neither is read for binding names.
 */
export const VALUE_MAPS: ReadonlySet<string> = new Set(["vars", "define"]);

/**
 * The kinds whose entries name their binding in `name` rather than `binding`. Every other kind wrangler
 * declares spells it `binding`, and a `name` there means something else — a Workflow's deployed name, a
 * container application's. `wranglerVars.test.ts` holds this to wrangler's own declarations.
 */
export const BINDING_NAMED_BY_NAME: ReadonlySet<string> = new Set([
  "durable_objects",
  "send_email",
  "ratelimits",
  "unsafe",
  "logfwdr",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The binding one entry declares, under the field its kind spells it with. */
function entryBinding(kind: string, entry: unknown): string | null {
  const record = asRecord(entry);
  if (record === null) return null;
  if (typeof record.binding === "string") return record.binding;
  return BINDING_NAMED_BY_NAME.has(kind) && typeof record.name === "string" ? record.name : null;
}

/**
 * Every binding name one `wrangler.jsonc` declares, and the kind it is declared under — the top level
 * **and** every `env.<name>`, since a binding declared for one environment is still a name the Worker
 * reads.
 *
 * **Shape, not a table of kinds.** A binding is an entry naming itself in `binding` — in an array
 * (`workflows`, `kv_namespaces`, …), on the object itself (`ai`, `browser`, `assets`), or in an array
 * the object wraps (`queues.producers`, `durable_objects.bindings`) — or in `name`, for the few kinds
 * {@link BINDING_NAMED_BY_NAME} lists. So it holds for the forty kinds wrangler has today and for the one
 * it adds next, unless that one is spelled by `name`; the gate in the test is what says so.
 *
 * The first kind a name is found under wins. Two kinds sharing one binding name is a config wrangler
 * refuses, so which one is reported does not matter.
 */
export function bindingsIn(config: unknown): Map<string, string> {
  const found = new Map<string, string>();
  const root = asRecord(config);
  if (root === null) return found;
  const stanzas = [root, ...Object.values(asRecord(root.env) ?? {}).map(asRecord)];
  for (const stanza of stanzas) {
    for (const [kind, value] of Object.entries(stanza ?? {})) {
      if (kind === "env" || VALUE_MAPS.has(kind)) continue;
      const record = asRecord(value);
      const entries = Array.isArray(value)
        ? value
        : [record, ...Object.values(record ?? {}).flatMap((inner) => (Array.isArray(inner) ? inner : []))];
      for (const entry of entries) {
        const name = entryBinding(kind, entry);
        if (name !== null && !found.has(name)) found.set(name, kind);
      }
    }
  }
  return found;
}

/**
 * Every binding one Worker's `wrangler.jsonc` declares, by name, with its kind. The sibling of
 * {@link declaredVars}, and for the same reason: two names a `.dev.vars` key can collide with, read in
 * one place. An unreadable or absent config declares nothing.
 */
export async function declaredBindings(workerDir: string): Promise<Map<string, string>> {
  return bindingsIn(await readWranglerConfig(workerDir).catch(() => null));
}
