// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type BindingSpec, BindingType } from "@pithy-sh/core/src/capability/bindings";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { isValidEnvironment } from "@pithy-sh/core/src/naming/environment";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { z } from "zod";
import { countPendingMigrations, type DatabaseRun, migrateProject } from "../migrations/run";
import { allCapabilities, loadWorkerConfig } from "../project/config";
import { applyVersionMetadata, hasVersionMetadata } from "../project/versionMetadata";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";
import { ejectedCapabilities } from "./eject";
import { findEntitlementGap } from "./entitlementGap";
import { availableManifests } from "./manifests";

/**
 * The shared reconcile engine behind `pithy upgrade` and (read-only) `pithy doctor` — one plan-builder,
 * two commands. {@link buildReconcilePlan} inspects **one Worker** and reports the drift between each
 * capability's manifest and that Worker's `wrangler.jsonc` + `pithy.config.ts` without writing a byte;
 * {@link applyReconcilePlan} is the write step `upgrade` runs against that plan. Doctor calls the builder
 * alone and only renders it. Both commands fan the engine out over every Worker.
 *
 * **Two directories, deliberately distinct.** `workerDir` (`apps/<name>/`) is the *wiring*: the Worker's own
 * `pithy.config.ts` and `wrangler.jsonc` — what a plan reads and an apply writes. `projectDir` (the repo root)
 * is only where **manifests** resolve from, since packages install once into the root
 * `node_modules/@pithy-sh/*` and every Worker shares them.
 *
 * **Installed is not composed.** Because that one install is shared, the manifests at the root are every
 * capability installed *anywhere* in the project — not what this Worker is made of. A plan is therefore scoped
 * to the Worker's own composed set (its `pithy.config.ts`): a capability another Worker added contributes
 * nothing here. Anything else would put a foreign capability's bindings, and its Durable Object class
 * migrations, on a script that never declared them.
 */

/** A required binding a capability's manifest declares that a given environment's wrangler stanza lacks. */
export const MissingBinding = z
  .object({
    env: z
      .string()
      .describe('The environment missing the binding — "dev" for the top-level stanza, else the env.<name> key.'),
    name: z.string().describe('The Worker env binding name the capability requires (e.g. "DB", "SESSIONS").'),
    type: BindingType.describe(
      "The kind of Cloudflare resource the binding refers to (d1, kv, r2, durable_object, …).",
    ),
  })
  .describe("A required binding absent from one environment's wrangler.jsonc stanza.");
export type MissingBinding = z.infer<typeof MissingBinding>;

/** A capability config option present in the manifest but not yet written into its pithy.config.ts call. */
export const MissingConfigKey = z
  .object({
    key: z.string().describe("The option name to add to the capability's registration call in pithy.config.ts."),
    default: z
      .union([z.string(), z.number(), z.boolean()])
      .describe("The manifest default rendered as the option's value (an adopter can change it afterward)."),
    describe: z.string().describe("The option's rationale, rendered as the comment above it in pithy.config.ts."),
  })
  .describe("A manifest config option not yet present in the capability's pithy.config.ts registration.");
export type MissingConfigKey = z.infer<typeof MissingConfigKey>;

/** One installed, non-ejected capability's drift: the bindings and config keys its manifest adds beyond the project. */
export const CapabilityReconcile = z
  .object({
    name: z.string().describe("The capability's short name (its manifest name)."),
    missingBindings: z
      .array(MissingBinding)
      .describe("Required bindings absent from one or more environments' wrangler.jsonc stanzas."),
    missingConfigKeys: z
      .array(MissingConfigKey)
      .describe("Manifest config options not yet present in this capability's pithy.config.ts registration."),
  })
  .describe("The reconcile drift for a single installed, non-ejected capability.");
export type CapabilityReconcile = z.infer<typeof CapabilityReconcile>;

/** The read-only reconcile plan: what an upgrade would add, what it would skip, and how far the schema is behind. */
export const ReconcilePlan = z
  .object({
    worker: z
      .string()
      .describe("The Worker this plan targets — its name as `pithy worker list` shows it (its apps/<name> dir)."),
    env: z.string().describe("The environment the pending-migration count was computed for."),
    perCapability: z
      .array(CapabilityReconcile)
      .describe("Per installed, non-ejected capability: the bindings and config keys an upgrade would add."),
    ejectedSkipped: z
      .array(z.string())
      .describe("Ejected capabilities, by name — never reconciled, since ejected code no longer tracks its package."),
    pendingMigrations: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Unapplied migrations for `env` across this Worker's databases — applied only when upgrade runs with --migrate.",
      ),
    entitlementGap: z
      .array(z.string())
      .describe(
        "This Worker's own source files that gate a route on an entitlement while nothing it composes provides one. Empty means no gap. Report-only: an upgrade cannot fix it, because which capability to compose is the adopter's decision.",
      ),
    missingVersionMetadata: z
      .boolean()
      .describe(
        "Whether this Worker's wrangler.jsonc lacks the `version_metadata` binding named `CF_VERSION_METADATA`. Without it a Worker cannot report which build is running, so log records carry no `version`, audit events carry no build id, and `pithy deploy` cannot verify the deploy it just made. An upgrade adds it; a config naming a different binding is reported and left alone.",
      ),
  })
  .describe(
    "A read-only reconcile plan for one Worker: binding/config drift, ejected skips, pending migrations, and the entitlement composition gap.",
  );
export type ReconcilePlan = z.infer<typeof ReconcilePlan>;

/** The one Worker a migration seam runs against, plus the project root its local D1 state lives under. */
export interface MigrationScope {
  /** The project root — the owner of the shared `.wrangler/state` store, not a source of wiring. */
  projectDir: string;
  /** The Worker's directory — its `wrangler.jsonc` supplies the D1 bindings and their ids. */
  workerDir: string;
  /** The Worker's name, so the migration run reports against it. */
  worker: string;
  /** The environment to run against. */
  env: string;
  /** The Worker's composed capabilities — the migration registry. */
  capabilities: Capability[];
}

/**
 * A scope that will **write**: the same Worker, plus the project every database it touches is claimed
 * for. Separate from {@link MigrationScope} because the read side is not the write side — `pithy doctor`
 * counts pending migrations on a project that may have no `name` yet, while `pithy upgrade --migrate`
 * must name itself or leave a database unowned for the next project to adopt.
 */
export interface MigrateScope extends MigrationScope {
  /** The project name (root `pithy.config.ts` `name`, via `requireProjectName`) each database is claimed for. */
  project: string;
}

/** Count one Worker's pending migrations for an environment — the migration seam, injectable for tests. */
export type CountPending = (options: MigrationScope) => Promise<number>;

/** Run one Worker's migrations for an environment — the apply-time migration seam, injectable for tests. */
export type RunMigrate = (options: MigrateScope) => Promise<DatabaseRun[]>;

// The migration entry points fan out over `apps/` themselves; reconcile is already inside that fan-out, so it
// hands them the single pre-resolved Worker it is reconciling. `projectDir` stays the project root — the local
// Miniflare store lives at `<root>/.wrangler/state`, shared with `wrangler dev`, never per Worker.
function scopeFor({ projectDir, workerDir, worker, env, capabilities }: MigrationScope) {
  return { projectDir, env, workers: [{ name: worker, dir: workerDir, capabilities }] };
}

const defaultCountPending: CountPending = (scope) => countPendingMigrations(scopeFor(scope));

const defaultRunMigrate: RunMigrate = async (scope) =>
  (await migrateProject({ ...scopeFor(scope), project: scope.project })).flatMap((run) => run.databases);

/** Options for {@link buildReconcilePlan}. `capabilities` may be passed to skip loading (and executing) pithy.config.ts. */
export interface BuildReconcilePlanOptions {
  /** The project root — only where `node_modules/@pithy-sh/*` (and so every capability manifest) resolves from. */
  projectDir: string;
  /** The Worker's directory (`apps/<name>/`) — the wiring: its own pithy.config.ts and wrangler.jsonc. */
  workerDir: string;
  /** The Worker's name, carried on the plan so a fan-out report can label it. Defaults to `workerDir`'s basename. */
  worker?: string;
  /** The environment the pending-migration count is computed for. Binding drift is reported across every environment regardless. */
  env: string;
  /**
   * The Worker's composed capabilities (libraries + app) — **the scope of the whole plan**, not just its
   * migration count. Only a capability named here is reconciled; one installed at the project root for
   * another Worker contributes nothing. Loaded from this Worker's own `pithy.config.ts` when omitted.
   */
  capabilities?: Capability[];
  /** Test seam: count pending migrations without a real Miniflare/D1 run. */
  countPending?: CountPending;
}

/**
 * A wrangler stanza's binding arrays — the keys reconcile reads and writes. Mirrors `pithy add`'s private
 * shape (the two are kept in lockstep by intent). `durable_objects.bindings` is per-environment; the DO
 * class `migrations` tag is top-level only.
 */
interface WranglerBindings {
  d1_databases?: { binding: string; database_name?: string }[];
  kv_namespaces?: { binding: string }[];
  r2_buckets?: { binding: string }[];
  durable_objects?: { bindings: { name: string; class_name: string }[] };
  migrations?: { tag: string; new_sqlite_classes?: string[] }[];
  env?: Record<string, WranglerBindings | undefined>;
}

/** The single DO class-migration tag Pithy scaffolds under, matching `pithy add`. */
const DO_MIGRATION_TAG = "v1";

/** Escape a capability name for use inside a `RegExp`. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Which project and which environment a stanza's proposed names are composed for. Mirrors `pithy add`. */
interface NameScope {
  /** The project name, or absent when the caller could not resolve one — in which case nothing is proposed. */
  project?: string;
  /** The environment this stanza *is* — `dev` for the top-level one, else the `env.<name>` key. */
  env: string;
}

/**
 * The `<project>-<env>-<binding>` name to propose for a binding, or `undefined` when there is nothing
 * safe to propose. The naming facade owns the one rule *and* the per-namespace budget, so this proposal
 * is byte-identical to `pithy add`'s — see `add.ts:proposeName` for why the two skips exist.
 *
 * The skip on an unaccepted environment matters more here than it does in `add`: `buildReconcilePlan`
 * is what `pithy doctor` runs, and a diagnostic that throws on an adopter's own `env.<key>` reports
 * nothing at all about the environments it could have checked.
 */
function proposeName(scope: NameScope, binding: string, kind: "d1" | "kv"): string | undefined {
  if (scope.project === undefined || !isValidEnvironment(scope.env)) return undefined;
  return resourceNames(scope.project).env(scope.env)[kind](binding);
}

/** Every environment's binding stanza: the top-level one (reported as "dev") plus each `env.<name>`. */
function envStanzas(wrangler: WranglerBindings): { env: string; stanza: WranglerBindings }[] {
  const list: { env: string; stanza: WranglerBindings }[] = [{ env: "dev", stanza: wrangler }];
  for (const [env, stanza] of Object.entries(wrangler.env ?? {})) {
    if (stanza) list.push({ env, stanza });
  }
  return list;
}

/**
 * Whether a stanza already declares a binding. `null` means the binding kind has no wrangler-array wiring
 * reconcile handles (email, secret, workflow, service, ai, vectorize, queue, ratelimit) — those are skipped,
 * matching what `pithy add` wires. r2 is handled here beyond `add`'s current set, since it maps cleanly to
 * `r2_buckets`.
 */
function stanzaHasBinding(stanza: WranglerBindings, binding: BindingSpec): boolean | null {
  switch (binding.type) {
    case "d1":
      return (stanza.d1_databases ?? []).some((entry) => entry.binding === binding.name);
    case "kv":
      return (stanza.kv_namespaces ?? []).some((entry) => entry.binding === binding.name);
    case "r2":
      return (stanza.r2_buckets ?? []).some((entry) => entry.binding === binding.name);
    case "durable_object":
      return (stanza.durable_objects?.bindings ?? []).some((entry) => entry.name === binding.name);
    default:
      return null;
  }
}

/** Every required binding absent from an environment, across every environment. Unsupported kinds are skipped. */
function computeMissingBindings(
  manifest: CapabilityManifest,
  stanzas: { env: string; stanza: WranglerBindings }[],
): MissingBinding[] {
  const missing: MissingBinding[] = [];
  for (const binding of manifest.requiredBindings) {
    // An `optional` binding is one the capability only needs under a particular config — the seam's
    // `CONTROL_PLANE` KV, which nothing reads under the default `d1` replay backend. The manifest is one
    // static file and cannot vary with config, so it declares the union and marks such a binding
    // optional; writing it anyway would make every project provision and bind a namespace no code path
    // in the tree ever reads, and re-add it the moment an adopter deleted it. `createBackend` reads the
    // same flag to decide whether a missing binding is fatal at assembly.
    if (binding.optional) continue;
    for (const { env, stanza } of stanzas) {
      const has = stanzaHasBinding(stanza, binding);
      if (has === null) break; // unsupported kind — the same for every env, skip it entirely
      if (!has) missing.push({ env, name: binding.name, type: binding.type });
    }
  }
  return missing;
}

/** A located capability registration call in pithy.config.ts source. */
type RegistrationLocation =
  | { form: "oneliner"; indent: string; presentKeys: string[] }
  | { form: "block"; indent: string; presentKeys: string[]; closeIndex: number };

/** From a `{`, the index of its matching `}` — string- and comment-aware so braces in strings/comments don't miscount. */
function matchBrace(source: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let quote = "";
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** True when the next non-whitespace character at or after `from` is a `:` — i.e. the token before it is a key. */
function followedByColon(body: string, from: number): boolean {
  let k = from;
  while (k < body.length && /\s/.test(body[k] as string)) k++;
  return body[k] === ":";
}

/**
 * The top-level object keys in a registration body — string- and comment-aware (line and block comments),
 * recognizing both bare identifier keys (`basePath:`) and quoted keys (`"base-path":`, `'x':`). Scalars-only
 * bodies. A quoted key is returned unquoted, so it compares equal to the manifest option name.
 */
function objectKeys(body: string): string[] {
  const keys: string[] = [];
  let i = 0;
  let depth = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      // Consume the whole string, then — at depth 0 and followed by `:` — record it as a quoted key.
      const quote = ch;
      let j = i + 1;
      while (j < body.length && body[j] !== quote) {
        if (body[j] === "\\") j += 2;
        else j++;
      }
      if (depth === 0 && followedByColon(body, j + 1)) keys.push(body.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    if (ch === "/" && body[i + 1] === "/") {
      const nl = body.indexOf("\n", i);
      if (nl === -1) break;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && body[i + 1] === "*") {
      const end = body.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && ch !== undefined && /[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < body.length && /[\w$]/.test(body[j] as string)) j++;
      if (followedByColon(body, j)) keys.push(body.slice(i, j));
      i = j;
      continue;
    }
    i++;
  }
  return keys;
}

/** Find a capability's registration call in pithy.config.ts source, and which option keys it already carries. */
function locateRegistration(source: string, name: string): RegistrationLocation | null {
  const re = new RegExp(`^([ \\t]*)${escapeRegExp(name)}[ \\t]*\\(`, "m");
  const match = re.exec(source);
  if (!match) return null;
  const indent = match[1] ?? "";
  const parenIndex = match.index + match[0].length - 1;
  let i = parenIndex + 1;
  while (i < source.length && /\s/.test(source[i] as string)) i++;
  const ch = source[i];
  if (ch === ")") return { form: "oneliner", indent, presentKeys: [] };
  if (ch === "{") {
    const closeIndex = matchBrace(source, i);
    if (closeIndex === -1) return null;
    return { form: "block", indent, presentKeys: objectKeys(source.slice(i + 1, closeIndex)), closeIndex };
  }
  return null;
}

/** Manifest config options not yet written into the capability's registration. Unregistered → nothing to add. */
function computeMissingConfigKeys(manifest: CapabilityManifest, configSource: string): MissingConfigKey[] {
  if (manifest.configOptions.length === 0) return [];
  const location = locateRegistration(configSource, manifest.name);
  if (!location) return [];
  return manifest.configOptions
    .filter((option) => !location.presentKeys.includes(option.key))
    .map((option) => ({ key: option.key, default: option.default, describe: option.describe }));
}

/** Read a Worker's pithy.config.ts source as text (never executed here); an unreadable file yields no config drift. */
async function readConfigSource(workerDir: string): Promise<string> {
  try {
    return await readFile(join(workerDir, "pithy.config.ts"), "utf8");
  } catch {
    return "";
  }
}

/** A Worker with no `wrangler.jsonc` has no stanzas to reconcile — report no binding drift rather than failing. */
async function readStanzas(workerDir: string): Promise<{ env: string; stanza: WranglerBindings }[]> {
  try {
    return envStanzas((await readWranglerConfig(workerDir)) as WranglerBindings);
  } catch {
    return [];
  }
}

/**
 * Build the read-only reconcile plan for **one Worker**. For every capability *that Worker composes* and has
 * not ejected, report the required bindings missing from each of its environments and the manifest config
 * options missing from its `apps/<name>/pithy.config.ts` call, plus the Worker's pending-migration count for
 * `env`. Manifests come from the project root (`node_modules/@pithy-sh/*`); everything else is per Worker.
 * Writes nothing — safe for `pithy doctor` to call on every run.
 */
export async function buildReconcilePlan(options: BuildReconcilePlanOptions): Promise<ReconcilePlan> {
  const { projectDir, workerDir, env } = options;
  const worker = options.worker ?? basename(workerDir);
  const capabilities = options.capabilities ?? allCapabilities(await loadWorkerConfig(workerDir));
  const countPending = options.countPending ?? defaultCountPending;

  const manifests = await availableManifests(projectDir);
  const ejected = await ejectedCapabilities(workerDir);
  const configSource = await readConfigSource(workerDir);
  const stanzas = await readStanzas(workerDir);
  // The Worker's own composed set, by name. Manifests resolve from the shared root install, so this is the
  // only thing that distinguishes "installed in the project" from "part of this Worker".
  const composed = new Set(capabilities.map((capability) => capability.name));

  const perCapability: CapabilityReconcile[] = [];
  for (const manifest of manifests) {
    if (ejected.includes(manifest.name)) continue; // ejected — reported below, never reconciled
    if (!composed.has(manifest.name)) continue; // installed at the root for another Worker — not this one's
    perCapability.push({
      name: manifest.name,
      missingBindings: computeMissingBindings(manifest, stanzas),
      missingConfigKeys: computeMissingConfigKeys(manifest, configSource),
    });
  }
  perCapability.sort((a, b) => a.name.localeCompare(b.name));
  const ejectedSkipped = [...ejected].sort((a, b) => a.localeCompare(b));

  const pendingMigrations = await countPending({ projectDir, workerDir, worker, env, capabilities });
  // Report-only, and scoped to this Worker's own source: the gates are on its routes, and the provider is
  // in its composed set, so the question is per Worker exactly as the rest of the plan is.
  const entitlementGap = await findEntitlementGap(workerDir, capabilities);
  // Not a capability binding, so it does not travel through the manifest path above: no capability
  // requires it, every Worker wants it, and the platform populates it. It is a property of the scaffold,
  // and the reason it is reconciled at all is that it shipped missing from both templates once already.
  const missingVersionMetadata = !hasVersionMetadata(await readWranglerConfig(workerDir).catch(() => null));
  return { worker, env, perCapability, ejectedSkipped, pendingMigrations, entitlementGap, missingVersionMetadata };
}

/**
 * Append a binding entry to a stanza if its name isn't already bound. Mirrors `pithy add`, plus r2 — the
 * two writers produce the same arrays through two implementations kept in lockstep by intent, so a change
 * to one is a change to the other. That includes the proposed `database_name`: if only `add` wrote it, a
 * capability wired by `pithy upgrade` would get a nameless D1 while a capability wired by `pithy add` got
 * a project-scoped one, from the same manifest.
 *
 * The presence check keys on `binding` **alone**, deliberately. Comparing the name too would read an
 * adopter's renamed database as a missing binding, and `upgrade` would append a second entry for a
 * binding wrangler already has.
 */
function appendBindings(stanza: WranglerBindings, manifest: CapabilityManifest, scope: NameScope): void {
  for (const binding of manifest.requiredBindings) {
    // An `optional` binding is one the capability only needs under a particular config — the seam's
    // `CONTROL_PLANE` KV, which nothing reads under the default `d1` replay backend. The manifest is one
    // static file and cannot vary with config, so it declares the union and marks such a binding
    // optional; writing it anyway would make every project provision and bind a namespace no code path
    // in the tree ever reads, and re-add it the moment an adopter deleted it. `createBackend` reads the
    // same flag to decide whether a missing binding is fatal at assembly.
    if (binding.optional) continue;
    if (binding.type === "d1") {
      stanza.d1_databases ??= [];
      if (!stanza.d1_databases.some((entry) => entry.binding === binding.name)) {
        const name = proposeName(scope, binding.name, "d1");
        stanza.d1_databases.push({ binding: binding.name, ...(name ? { database_name: name } : {}) });
      }
    }
    if (binding.type === "kv") {
      stanza.kv_namespaces ??= [];
      if (!stanza.kv_namespaces.some((entry) => entry.binding === binding.name)) {
        stanza.kv_namespaces.push({ binding: binding.name });
      }
    }
    if (binding.type === "r2") {
      stanza.r2_buckets ??= [];
      if (!stanza.r2_buckets.some((entry) => entry.binding === binding.name)) {
        stanza.r2_buckets.push({ binding: binding.name });
      }
    }
    if (binding.type === "durable_object" && binding.className) {
      stanza.durable_objects ??= { bindings: [] };
      stanza.durable_objects.bindings ??= [];
      if (!stanza.durable_objects.bindings.some((entry) => entry.name === binding.name)) {
        stanza.durable_objects.bindings.push({ name: binding.name, class_name: binding.className });
      }
    }
  }
}

/** Register a manifest's DO classes in the top-level `migrations` tag, matching `pithy add`. */
function appendDurableObjectMigrations(config: WranglerBindings, manifest: CapabilityManifest): void {
  const classes = manifest.requiredBindings
    .filter((binding) => binding.type === "durable_object" && binding.className)
    .map((binding) => binding.className as string);
  if (classes.length === 0) return;

  config.migrations ??= [];
  let tag = config.migrations.find((migration) => migration.tag === DO_MIGRATION_TAG);
  if (!tag) {
    tag = { tag: DO_MIGRATION_TAG, new_sqlite_classes: [] };
    config.migrations.push(tag);
  }
  tag.new_sqlite_classes ??= [];
  for (const className of classes) {
    if (!tag.new_sqlite_classes.includes(className)) tag.new_sqlite_classes.push(className);
  }
}

/** Render one option's `// describe` + `key: default` lines at a given indent, matching `pithy add`. */
function renderKeyLines(keys: MissingConfigKey[], indent: string): string {
  const lines: string[] = [];
  for (const key of keys) {
    lines.push(`${indent}// ${key.describe}`);
    lines.push(`${indent}${key.key}: ${JSON.stringify(key.default)},`);
  }
  return lines.join("\n");
}

/** Convert a one-liner `name(),` registration to block form, inserting the missing keys. */
function convertOneLiner(source: string, name: string, indent: string, keys: MissingConfigKey[]): string {
  const inner = `${indent}  `;
  const block = `${name}({\n${renderKeyLines(keys, inner)}\n${indent}})`;
  const re = new RegExp(`^([ \\t]*)${escapeRegExp(name)}[ \\t]*\\(\\s*\\)`, "m");
  // A replacement function keeps any `$` in the rendered defaults literal.
  return source.replace(re, (_match, ind: string) => `${ind}${block}`);
}

/**
 * Insert missing keys into an existing block registration, before its closing brace. Never rewrites a key.
 * A separating comma is spliced onto the prior property when it lacks a trailing one — otherwise inserting
 * after `{ x: 1 }` (an adopter's hand-written inline block) would produce `{ x: 1  y: 2 }`, invalid TypeScript.
 */
function insertIntoBlock(source: string, closeIndex: number, keys: MissingConfigKey[]): string {
  // The last real character of the block body: `,` or `{` (empty block) means no separator is needed.
  let last = closeIndex - 1;
  while (last >= 0 && /\s/.test(source[last] as string)) last--;
  const needComma = source[last] !== "," && source[last] !== "{";

  // Splice the comma directly after the last property (not before the closing brace) so no stray space is
  // introduced, then insert the new keys before the — possibly shifted — closing brace.
  const withComma = needComma ? `${source.slice(0, last + 1)},${source.slice(last + 1)}` : source;
  const close = closeIndex + (needComma ? 1 : 0);

  const lineStart = withComma.lastIndexOf("\n", close - 1) + 1;
  const prefixOnLine = withComma.slice(lineStart, close);
  if (prefixOnLine.trim() === "") {
    // The close brace sits on its own line — insert whole key lines above it.
    const inner = `${prefixOnLine}  `;
    return `${withComma.slice(0, lineStart)}${renderKeyLines(keys, inner)}\n${withComma.slice(lineStart)}`;
  }
  // Inline block (`name({ x: 1 })`) — append `key: value,` before the closing brace.
  const inline = keys.map((key) => ` ${key.key}: ${JSON.stringify(key.default)},`).join("");
  return `${withComma.slice(0, close)}${inline}${withComma.slice(close)}`;
}

/** Options for {@link applyReconcilePlan} — the write step, run only by `pithy upgrade`. */
export interface ApplyReconcilePlanOptions {
  /** The project root — where the capability manifests resolve from. */
  projectDir: string;
  /** The Worker's directory (`apps/<name>/`) — the pithy.config.ts and wrangler.jsonc this writes. */
  workerDir: string;
  /** The plan to apply, from {@link buildReconcilePlan}. */
  plan: ReconcilePlan;
  /** Run the Worker's pending migrations after reconciling; leaves them pending when false. */
  migrate: boolean;
  /** The environment migrations run against when `migrate` is set. */
  env: string;
  /**
   * The project name, resolved by the caller from the root `pithy.config.ts` (`requireProjectName`) and
   * passed as a plain string — the first segment of every `database_name` this proposes, and the owner
   * stamped on every database a `migrate` run touches.
   *
   * Optional, because the two uses have different stakes. A missing name costs the *proposal* nothing
   * worse than a binding-only entry, exactly as before, and `pithy doctor` says why. A missing name on a
   * **write** is not survivable the same way — an unstamped database is one any project can later claim
   * — so `migrate` without a project is refused below, before a single file is touched.
   */
  project?: string;
  /** The Worker's composed capabilities (libraries + app) — passed to the migration run. */
  capabilities: Capability[];
  /** Test seam: run migrations without a real Miniflare/D1 run. */
  runMigrate?: RunMigrate;
}

/** What one capability's apply changed: the bindings and config keys actually added. */
export interface CapabilityApplied {
  /** The capability's short name. */
  name: string;
  /** The bindings added to wrangler.jsonc for this capability. */
  addedBindings: MissingBinding[];
  /** The config option keys inserted into this capability's pithy.config.ts registration. */
  addedConfigKeys: string[];
}

/** The summary {@link applyReconcilePlan} returns — what was written, what was skipped, whether migrations ran. */
export interface ReconcileApplied {
  /** The Worker this apply targeted, carried through from the plan so a fan-out report can label it. */
  worker: string;
  /** Per capability that changed: the bindings and config keys added. */
  perCapability: CapabilityApplied[];
  /** Ejected capabilities, by name — reported, never touched. */
  ejectedSkipped: string[];
  /** Whether the migration step ran (only when the caller passed `migrate`). */
  migrated: boolean;
  /** The per-database migration runs, when `migrated`; empty otherwise. */
  migrations: DatabaseRun[];
  /** Whether this run added the `version_metadata` binding the Worker was missing. */
  addedVersionMetadata: boolean;
}

/** Add every plan capability's missing bindings to the Worker's wrangler.jsonc, comment-preserving. Returns what was added per capability. */
async function applyBindings(
  projectDir: string,
  workerDir: string,
  plan: ReconcilePlan,
  project: string | undefined,
): Promise<Map<string, MissingBinding[]>> {
  const added = new Map<string, MissingBinding[]>();
  const caps = plan.perCapability.filter((cap) => cap.missingBindings.length > 0);
  if (caps.length === 0) return added;

  const byName = new Map((await availableManifests(projectDir)).map((manifest) => [manifest.name, manifest]));
  const config = (await readWranglerConfig(workerDir)) as WranglerBindings;
  const stanzas = envStanzas(config);
  let touched = false;
  for (const cap of caps) {
    const manifest = byName.get(cap.name);
    if (!manifest) continue; // installed manifest vanished — nothing to wire
    // Each stanza is written for the environment it *is*, so the name it proposes has that environment
    // in it. `envStanzas` already pairs them on the read side; the write side uses the same pairing.
    for (const { env, stanza } of stanzas) {
      appendBindings(stanza, manifest, { ...(project === undefined ? {} : { project }), env });
    }
    appendDurableObjectMigrations(config, manifest);
    added.set(cap.name, cap.missingBindings);
    touched = true;
  }
  if (touched) await writeWranglerConfig(workerDir, config);
  return added;
}

/** Insert every plan capability's missing config keys into the Worker's pithy.config.ts, never rewriting an existing key. */
async function applyConfigKeys(workerDir: string, plan: ReconcilePlan): Promise<Map<string, string[]>> {
  const added = new Map<string, string[]>();
  const caps = plan.perCapability.filter((cap) => cap.missingConfigKeys.length > 0);
  if (caps.length === 0) return added;

  const path = join(workerDir, "pithy.config.ts");
  let source = await readFile(path, "utf8");
  let changed = false;
  for (const cap of caps) {
    // Re-locate on the current (possibly-mutated) source so offsets stay valid and already-present keys
    // are re-checked — that makes a re-apply of a stale plan a no-op rather than a duplicate.
    const location = locateRegistration(source, cap.name);
    if (!location) continue;
    const toAdd = cap.missingConfigKeys.filter((key) => !location.presentKeys.includes(key.key));
    if (toAdd.length === 0) continue;
    source =
      location.form === "oneliner"
        ? convertOneLiner(source, cap.name, location.indent, toAdd)
        : insertIntoBlock(source, location.closeIndex, toAdd);
    added.set(
      cap.name,
      toAdd.map((key) => key.key),
    );
    changed = true;
  }
  if (changed) await writeFile(path, source);
  return added;
}

/**
 * The project a `--migrate` run claims each database for, or a refusal. `pithy upgrade` reconciles wiring
 * happily without a project name — the proposals just carry their binding — but the moment it is asked to
 * migrate, the name stops being cosmetic: it is the owner stamped on every database the run touches, and a
 * database left unstamped is one any other project can later claim.
 */
function requireMigrationProject(project: string | undefined): string {
  if (project === undefined) {
    throw new ValidationError({
      message: "pithy upgrade --migrate needs a project name.",
      action:
        "Set `name` in pithy.config.ts, then run pithy upgrade --migrate again. It stamps each database as this project's, so another project's database is refused instead of silently merged.",
    });
  }
  return project;
}

/**
 * Apply a reconcile plan — the write step behind `pithy upgrade`, never called by `doctor`. Adds the
 * missing bindings to the Worker's `wrangler.jsonc` and the missing config keys to its `pithy.config.ts`
 * (a one-liner call becomes block form; an existing block gains only the absent keys — an adopter-changed
 * value is never touched), then runs that Worker's migrations when `migrate` is set. Everything written is
 * inside `workerDir`. Idempotent: re-running after a build finds nothing missing and writes nothing.
 */
export async function applyReconcilePlan(options: ApplyReconcilePlanOptions): Promise<ReconcileApplied> {
  const { projectDir, workerDir, plan, env, capabilities } = options;
  const runMigrate = options.runMigrate ?? defaultRunMigrate;

  // The project to migrate as, or null for "don't migrate" — resolved first, so a nameless project fails
  // having written nothing rather than mid-fan-out with one Worker already reconciled. Reconciling wiring
  // is survivable without a name; writing to a database is not.
  const migrateAs = options.migrate ? requireMigrationProject(options.project) : null;

  const addedBindings = await applyBindings(projectDir, workerDir, plan, options.project);
  const addedConfigKeys = await applyConfigKeys(workerDir, plan);
  // Idempotent, and a no-op on a Worker that already declares it — including one that names a different
  // binding, which is reported rather than repointed.
  const addedVersionMetadata = plan.missingVersionMetadata ? await applyVersionMetadata(workerDir) : false;

  const perCapability: CapabilityApplied[] = [];
  for (const cap of plan.perCapability) {
    const bindings = addedBindings.get(cap.name) ?? [];
    const keys = addedConfigKeys.get(cap.name) ?? [];
    if (bindings.length === 0 && keys.length === 0) continue;
    perCapability.push({ name: cap.name, addedBindings: bindings, addedConfigKeys: keys });
  }

  let migrated = false;
  let migrations: DatabaseRun[] = [];
  if (migrateAs !== null) {
    migrations = await runMigrate({
      projectDir,
      workerDir,
      worker: plan.worker,
      env,
      capabilities,
      project: migrateAs,
    });
    migrated = true;
  }

  return {
    worker: plan.worker,
    perCapability,
    ejectedSkipped: plan.ejectedSkipped,
    migrated,
    migrations,
    addedVersionMetadata,
  };
}
