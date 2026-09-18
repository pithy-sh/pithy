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
 * The keys whose value is a whole block of config, read with the same reader as the top level. `env` holds
 * one per environment; `previews` is one — "all non-inheritable properties", in wrangler's words, which is
 * every binding kind. `wranglerVars.test.ts` holds this to wrangler's declarations: its gate sees into
 * `previews: PreviewsConfig` and would call it an ungated kind if it were not named here.
 */
export const STANZAS: ReadonlySet<string> = new Set(["env", "previews"]);

/** One binding a `wrangler.jsonc` declares: its kind, and the stanza it is declared in. */
export interface DeclaredBinding {
  /** The `wrangler.jsonc` key it is declared under — `workflows`, `d1_databases`, `durable_objects`. */
  kind: string;
  /**
   * Where, when not at the top level: `env.staging`, `previews`, `env.staging.previews`. `null` is the top
   * level — the only stanza `wrangler dev` applies, since `pithy dev` runs it with no `--env` and wrangler's
   * dev never reads `previews`.
   */
  in: string | null;
}

/** Every stanza of one config, in the order a name's label is decided: the top level, each env, then previews. */
function stanzasOf(root: Record<string, unknown>): { at: string | null; stanza: Record<string, unknown> | null }[] {
  const envs = Object.entries(asRecord(root.env) ?? {}).map(([name, value]) => ({
    at: `env.${name}`,
    stanza: asRecord(value),
  }));
  return [
    { at: null, stanza: root },
    ...envs,
    { at: "previews", stanza: asRecord(root.previews) },
    ...envs.map(({ at, stanza }) => ({ at: `${at}.previews`, stanza: asRecord(stanza?.previews) })),
  ];
}

/**
 * Every binding name one `wrangler.jsonc` declares, its kind, and where — the top level, every `env.<name>`,
 * and `previews` at either, each read by one reader, since a binding declared anywhere is a name the Worker
 * reads somewhere.
 *
 * **Shape, not a table of kinds.** A binding is an entry naming itself in `binding` — in an array
 * (`workflows`, `kv_namespaces`, …), on the object itself (`ai`, `browser`, `assets`), or in an array
 * the object wraps (`queues.producers`, `durable_objects.bindings`) — or in `name`, for the few kinds
 * {@link BINDING_NAMED_BY_NAME} lists. So it holds for the forty kinds wrangler has today and for the one
 * it adds next, unless that one is spelled by `name`; the gate in the test is what says so.
 *
 * **The top level labels a name first**, then each environment, then previews — so which one is written
 * first in the file decides nothing, and a top-level binding is never reported as a preview's. Two kinds
 * sharing one binding name inside one stanza is a config wrangler refuses, so which one is reported there
 * does not matter.
 */
export function bindingsIn(config: unknown): Map<string, DeclaredBinding> {
  const found = new Map<string, DeclaredBinding>();
  const root = asRecord(config);
  if (root === null) return found;
  for (const { at, stanza } of stanzasOf(root)) {
    for (const [kind, value] of Object.entries(stanza ?? {})) {
      if (STANZAS.has(kind) || VALUE_MAPS.has(kind)) continue;
      const record = asRecord(value);
      const entries = Array.isArray(value)
        ? value
        : [record, ...Object.values(record ?? {}).flatMap((inner) => (Array.isArray(inner) ? inner : []))];
      for (const entry of entries) {
        const name = entryBinding(kind, entry);
        if (name !== null && !found.has(name)) found.set(name, { kind, in: at });
      }
    }
  }
  return found;
}

/**
 * Every binding one Worker's `wrangler.jsonc` declares, by name, with its kind and stanza. The sibling of
 * {@link declaredVars}, and for the same reason: two names a `.dev.vars` key can collide with, read in
 * one place. An unreadable or absent config declares nothing.
 */
export async function declaredBindings(workerDir: string): Promise<Map<string, DeclaredBinding>> {
  return bindingsIn(await readWranglerConfig(workerDir).catch(() => null));
}

/**
 * Every name wrangler's `secrets.required` lists, in every stanza. Each is a secret the Worker reads:
 * `wrangler dev` loads it from `.dev.vars` as `secret_text`, and a deploy expects `wrangler secret put`.
 * Never a variable — a `vars` entry with that name is a config wrangler refuses to load.
 */
export function requiredSecretsIn(config: unknown): Set<string> {
  const names = new Set<string>();
  const root = asRecord(config);
  if (root === null) return names;
  for (const { stanza } of stanzasOf(root)) {
    const required = asRecord(stanza?.secrets)?.required;
    if (!Array.isArray(required)) continue;
    for (const name of required) if (typeof name === "string") names.add(name);
  }
  return names;
}

/** {@link requiredSecretsIn}, for one Worker's `wrangler.jsonc`. An unreadable or absent config declares none. */
export async function declaredRequiredSecrets(workerDir: string): Promise<Set<string>> {
  return requiredSecretsIn(await readWranglerConfig(workerDir).catch(() => null));
}
