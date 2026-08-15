// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type BindingSpec, BindingType } from "@pithy-sh/core/src/capability/bindings";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import {
  type CapabilityManifest,
  ConfigOption,
  ConfigOptionValue,
  renderCapabilityRegistration,
  renderConfigOptionComment,
  renderConfigOptionLine,
} from "@pithy-sh/core/src/capability/manifest";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { z } from "zod";
import type { CloudflareAccountSelection } from "../cloudflare/config";
import { type DatabaseRun, migrateProject, ProjectLedger, readProjectLedger } from "../migrations/run";
import {
  appendBinding,
  appendDurableObjectMigrations,
  type BindingScope,
  envStanzas,
  stanzaHasBinding,
  type WranglerStanza,
} from "../project/bindingEntries";
import { allCapabilities, loadWorkerConfig } from "../project/config";
import { applyVersionMetadata, hasVersionMetadata } from "../project/versionMetadata";
import { workerIdentity } from "../project/workerIdentity";
import { readWranglerConfig, writeWranglerConfig } from "../project/wrangler";
import { declaresConstant } from "./configConstants";
import { ejectedCapabilities } from "./eject";
import { findEntitlementGap } from "./entitlementGap";
import { availableManifests } from "./manifests";
import { MissingPrerequisite, missingPrerequisites } from "./prerequisites";

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

/** A binding an apply was asked to write and could not, with the reason the writer gave. */
export const SkippedBinding = MissingBinding.extend({
  reason: z
    .string()
    .describe(
      "Why the entry could not be composed, in an operator's words — the field the spec did not state, or the name that could not be derived.",
    ),
}).describe(
  "A required binding `pithy upgrade` could not write. Named rather than counted: reporting the plan instead of the write is what made `upgrade` claim five bindings it had declined, while `doctor` correctly still called them missing (#318).",
);
export type SkippedBinding = z.infer<typeof SkippedBinding>;

/** A capability config option present in the manifest but not yet written into its pithy.config.ts call. */
export const MissingConfigKey = z
  .object({
    // Every field is the manifest's own contract, not a copy of one. The copied `default` was a scalar
    // union, so an option whose value is a literal only the adopter can fill in — the one `pithy add
    // secrets` could not render at all (#161) — was the one option `pithy upgrade` could not report as
    // missing either. That value is now a whole worked example (#168), which is exactly why it is
    // rendered through the manifest's own `renderConfigOptionLine` rather than by anything this file
    // writes itself (#171). `key` and `describe` were still bare `z.string()` here after #174 narrowed
    // them at the manifest, which is the same copy waiting to drift the same way.
    key: ConfigOption.shape.key.describe(
      "The option name to add to the capability's registration call in pithy.config.ts.",
    ),
    default: ConfigOptionValue.describe(
      "The manifest default rendered as the option's value (an adopter can change it afterward).",
    ),
    describe: ConfigOption.shape.describe.describe(
      "The option's rationale, rendered as the comment above it in pithy.config.ts.",
    ),
    constant: ConfigOption.shape.constant.describe(
      "Present when this option is written as one of the scaffolded config's constants — `publicOrigin` renders as `PUBLIC_ORIGIN` — instead of as `default`. Only when this Worker's pithy.config.ts declares it; an older project keeps the literal rather than being handed an identifier nothing defines.",
    ),
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

/**
 * Whether this Worker's routes gate on an entitlement nothing composed provides — or that the scan could
 * not run (#371).
 *
 * The scan reads the Worker's own source tree, so it fails the way a directory fails: a permission, a
 * symlink loop, a tree that moved mid-read. An empty `gates` array was the answer for both "no gate" and
 * "no scan", and only one of those is good news — so the list lives behind `read` and a caller reaches it
 * by narrowing.
 */
export const EntitlementGap = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("read").describe("The Worker's source tree was scanned."),
        gates: z
          .array(z.string())
          .describe(
            "This Worker's own source files that gate a route on an entitlement while nothing it composes provides one, relative to its directory. Empty means no gap — the healthy state.",
          ),
      })
      .describe("The scan's answer. An empty list here is a real answer and means there is no gap."),
    z
      .object({
        state: z.literal("unavailable").describe("The Worker's source tree could not be scanned."),
      })
      .describe(
        "No scan was made, so nothing is known about this Worker's gates. Deliberately empty: nothing derived from the failure travels, and there is no empty list here to mistake for no gap.",
      ),
  ])
  .describe(
    "The entitlement-composition gap for one Worker, or that it could not be looked for. The file list sits behind the discriminant, so `no gap` and `no scan` cannot be confused.",
  );
export type EntitlementGap = z.infer<typeof EntitlementGap>;

/** The read-only reconcile plan: what an upgrade would add, what it would skip, and how far the schema is behind. */
export const ReconcilePlan = z
  .object({
    worker: z.string().describe("The Worker this plan targets, as its apps/<name> directory — what --worker accepts."),
    deployedAs: z
      .string()
      .describe("The same Worker's deployed script name, from wrangler.jsonc — what the Cloudflare dashboard shows."),
    env: z.string().describe("The environment the pending-migration count was computed for."),
    perCapability: z
      .array(CapabilityReconcile)
      .describe("Per installed, non-ejected capability: the bindings and config keys an upgrade would add."),
    ejectedSkipped: z
      .array(z.string())
      .describe("Ejected capabilities, by name — never reconciled, since ejected code no longer tracks its package."),
    ledger: ProjectLedger.describe(
      "What `env`'s databases have applied against what this Worker declares, in both directions — unapplied migrations (which an upgrade applies with --migrate) and migrations the ledger records that nothing declares any more (which it cannot: whether to restore the migration or drop its ledger row depends on what the database holds, so it is report-only). It is the ledger's own four-way value rather than two flat fields, because a database that could not be read is neither of those things and a count alone cannot say so (#282, #371).",
    ),
    entitlements: EntitlementGap.describe(
      "Whether this Worker gates a route on an entitlement while nothing it composes provides one — and whether the question could be asked at all. Report-only: an upgrade cannot fix it, because which capability to compose is the adopter's decision.",
    ),
    missingPrerequisites: z
      .array(MissingPrerequisite)
      .describe(
        "Capabilities this Worker composes whose manifest declares a peer it does not compose. The Worker will not assemble: createBackend refuses on exactly this pair, so it is a boot failure rather than drift. Report-only, like the entitlement gap — composing a capability is the adopter's decision, and `pithy add <cap> --with-prerequisites` is the command that makes it.",
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
  /**
   * The Cloudflare account this project belongs to, from `projectCloudflareAccount(projectDir)`, or
   * `null` when it names none. Required (#234): `pithy upgrade --migrate --env staging` reaches a real
   * D1 through this scope, and the account it reaches it in is the project's, never the default file's.
   */
  account: CloudflareAccountSelection | null;
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

/**
 * Read one Worker's migration ledger for an environment — the migration seam, injectable for tests.
 *
 * It used to return a number, and that number was the whole of what any caller could learn: how many
 * declared migrations had not run. An applied migration the project no longer declares is invisible to
 * that subtraction and is the state that stops `pithy migrate` dead, so the seam returns the comparison
 * rather than one side of it (#282).
 */
export type ReadLedger = (options: MigrationScope) => Promise<ProjectLedger>;

/** Run one Worker's migrations for an environment — the apply-time migration seam, injectable for tests. */
export type RunMigrate = (options: MigrateScope) => Promise<DatabaseRun[]>;

// The migration entry points fan out over `apps/` themselves; reconcile is already inside that fan-out, so it
// hands them the single pre-resolved Worker it is reconciling. `projectDir` stays the project root — the local
// Miniflare store lives at `<root>/.wrangler/state`, shared with `wrangler dev`, never per Worker.
function scopeFor({ projectDir, workerDir, worker, env, capabilities, account }: MigrationScope) {
  return { projectDir, env, account, workers: [{ name: worker, dir: workerDir, capabilities }] };
}

const defaultReadLedger: ReadLedger = (scope) => readProjectLedger(scopeFor(scope));

const defaultRunMigrate: RunMigrate = async (scope) =>
  (await migrateProject({ ...scopeFor(scope), project: scope.project })).flatMap((run) => run.databases);

/** Options for {@link buildReconcilePlan}. `capabilities` may be passed to skip loading (and executing) pithy.config.ts. */
export interface BuildReconcilePlanOptions {
  /** The project root — only where `node_modules/@pithy-sh/*` (and so every capability manifest) resolves from. */
  projectDir: string;
  /** The Worker's directory (`apps/<name>/`) — the wiring: its own pithy.config.ts and wrangler.jsonc. */
  workerDir: string;
  /**
   * The Worker's **deployed** script name, from its `wrangler.jsonc`. Reported on the plan as
   * `deployedAs`; the plan's `worker` is always `workerDir`'s basename and is never taken from here.
   * Defaults to the basename when a caller has no config to read.
   */
  worker?: string;
  /** The environment the pending-migration count is computed for. Binding drift is reported across every environment regardless. */
  env: string;
  /**
   * The Worker's composed capabilities (libraries + app) — **the scope of the whole plan**, not just its
   * migration count. Only a capability named here is reconciled; one installed at the project root for
   * another Worker contributes nothing. Loaded from this Worker's own `pithy.config.ts` when omitted.
   */
  capabilities?: Capability[];
  /**
   * The Cloudflare account this project belongs to, or `null` when it names none. Reaches the plan's one
   * network-capable step, the pending-migration count, and nothing else (#234).
   */
  account: CloudflareAccountSelection | null;
  /** Test seam: read the migration ledger without a real Miniflare/D1 run. */
  readLedger?: ReadLedger;
  /**
   * Test seam: find the entitlement gap without a source tree that refuses to read.
   *
   * It exists for the same reason `readLedger` does. The walk behind {@link findEntitlementGap} is
   * deliberately hard to make throw — `ci/sourceFiles.ts` treats a directory it cannot list as skipped —
   * and a guard nobody can drive is a guard nobody can prove. #371's gate on this contributor plants the
   * throw through here.
   */
  findGap?: (workerDir: string, capabilities: readonly Capability[]) => Promise<string[]>;
}

/** Escape a capability name for use inside a `RegExp`. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The bindings a capability actually needs *in this Worker*.
 *
 * A manifest is one static file and cannot vary with config, so a binding a capability needs only under
 * a particular setting is declared there as `optional` — the seam's `CONTROL_PLANE` KV, which nothing
 * reads under the default `d1` replay backend.
 *
 * **The manifest decides what is required; the composed instance decides whether an optional one is
 * needed here.** Non-optional entries always apply — that is what the manifest is for, and it is the
 * only source available to `pithy add`, which runs before any config exists. An optional entry is
 * included only when this Worker's *composed* capability genuinely requires it, which is knowable
 * because `controlplane({ replayBackend: "kv" })` pushes the KV binding, non-optional, exactly when it
 * is needed.
 *
 * Both halves matter. Skipping optional bindings outright left an adopter who selected `kv` with no
 * binding written by any CLI path and a hard assembly failure at boot. Taking the composed instance's
 * list wholesale instead would make the manifest dead weight and would report nothing at all for a
 * caller that passes a name-only capability marker.
 */
function effectiveBindings(manifest: CapabilityManifest, composed: Capability | undefined): BindingSpec[] {
  const required = manifest.requiredBindings.filter((binding) => !binding.optional);
  const optional = manifest.requiredBindings.filter((binding) => binding.optional);
  if (optional.length === 0) return required;

  const needed = new Set((composed?.requiredBindings ?? []).map((binding) => `${binding.type}:${binding.name}`));
  return [...required, ...optional.filter((binding) => needed.has(`${binding.type}:${binding.name}`))];
}

/** Every required binding absent from an environment, across every environment. Unsupported kinds are skipped. */
function computeMissingBindings(
  manifest: CapabilityManifest,
  stanzas: { env: string; stanza: WranglerStanza }[],
  composed: Capability | undefined,
): MissingBinding[] {
  const missing: MissingBinding[] = [];
  for (const binding of effectiveBindings(manifest, composed)) {
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
    .map((option) => ({
      key: option.key,
      default: option.default,
      describe: option.describe,
      // Decided against this Worker's own source, by the same function `pithy add` calls — so the two
      // commands write the same line for the same option, which is the whole reason the renderers are
      // shared (#171). An `upgrade` on a project that predates the scaffolded constant keeps the literal.
      ...(option.constant && declaresConstant(configSource, option.constant) ? { constant: option.constant } : {}),
    }));
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
async function readStanzas(workerDir: string): Promise<{ env: string; stanza: WranglerStanza }[]> {
  try {
    return envStanzas((await readWranglerConfig(workerDir)) as WranglerStanza);
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
  // The deployed name, kept under its own binding because two different consumers want two different
  // things from it. `readLedger` below builds a migration scope, where the Worker is identified the way
  // the migration ledger identifies it; the plan this returns is read by a person or a script holding the
  // checkout, where the `apps/` directory is the useful handle. Collapsing them is pithy-sh/pithy#144.
  const deployedAs = options.worker ?? basename(workerDir);
  const capabilities = options.capabilities ?? allCapabilities(await loadWorkerConfig(workerDir));
  const readLedger = options.readLedger ?? defaultReadLedger;

  const { manifests } = await availableManifests(projectDir);
  const ejected = await ejectedCapabilities(workerDir);
  const configSource = await readConfigSource(workerDir);
  const stanzas = await readStanzas(workerDir);
  // The Worker's own composed set, by name. Manifests resolve from the shared root install, so this is the
  // only thing that distinguishes "installed in the project" from "part of this Worker".
  const composed = new Set(capabilities.map((capability) => capability.name));
  // The composed instances, by name. Their `requiredBindings` are config-aware where a manifest cannot
  // be — see `effectiveBindings`.
  const byName = new Map(capabilities.map((capability) => [capability.name, capability]));

  const perCapability: CapabilityReconcile[] = [];
  for (const manifest of manifests) {
    if (ejected.includes(manifest.name)) continue; // ejected — reported below, never reconciled
    if (!composed.has(manifest.name)) continue; // installed at the root for another Worker — not this one's
    perCapability.push({
      name: manifest.name,
      missingBindings: computeMissingBindings(manifest, stanzas, byName.get(manifest.name)),
      missingConfigKeys: computeMissingConfigKeys(manifest, configSource),
    });
  }
  perCapability.sort((a, b) => a.name.localeCompare(b.name));
  const ejectedSkipped = [...ejected].sort((a, b) => a.localeCompare(b));

  // **Every contributor to this plan is guarded, and none of them is load-bearing (#371).** A plan is a
  // report, and a report is read by an adopter trying to find out why something is wrong — so one
  // contributor failing must cost its own line and leave the other four standing. The two below were the
  // unguarded ones; the config source, the wrangler stanzas and the version-metadata read beside them
  // have degraded per contributor since they were written.
  //
  // Neither guard takes a binding. `readLedger` reaches a customer's D1 and `findEntitlementGap` walks
  // their source tree, so both throw with paths, ids and queries in them — nothing derived from either
  // reaches this plan, which `pithy upgrade --json` prints.
  //
  // `try`/`catch` rather than `.catch()`, because `readLedger` is an injectable seam: a `.catch()` guards
  // a rejected promise and not a function that threw before returning one.
  let ledger: ProjectLedger;
  try {
    ledger = await readLedger({
      projectDir,
      workerDir,
      worker: deployedAs,
      env,
      capabilities,
      account: options.account,
    });
  } catch {
    ledger = { state: "unavailable" };
  }
  // Report-only, and scoped to this Worker's own source: the gates are on its routes, and the provider is
  // in its composed set, so the question is per Worker exactly as the rest of the plan is.
  let entitlements: EntitlementGap;
  try {
    entitlements = { state: "read", gates: await (options.findGap ?? findEntitlementGap)(workerDir, capabilities) };
  } catch {
    entitlements = { state: "unavailable" };
  }
  // Not a capability binding, so it does not travel through the manifest path above: no capability
  // requires it, every Worker wants it, and the platform populates it. It is a property of the scaffold,
  // and the reason it is reconciled at all is that it shipped missing from both templates once already.
  //
  // Only when the config is actually readable. A Worker with no `wrangler.jsonc` — a Vite frontend that
  // joins the dev set through `pithy.worker.jsonc` and never deploys — is not missing a binding, it is
  // missing a deploy target, and reporting drift an apply then declines to fix is worse than silence.
  // The same holds for a config with a syntax error: the honest answer is that this cannot be assessed.
  const wrangler = await readWranglerConfig(workerDir).catch(() => null);
  const missingVersionMetadata = wrangler !== null && !hasVersionMetadata(wrangler);
  return {
    ...workerIdentity({ name: deployedAs, dir: workerDir }),
    env,
    perCapability,
    ejectedSkipped,
    ledger,
    entitlements,
    // Across every composed capability, ejected ones included: eject copies the source, it does not
    // change what that source composes against, and `createBackend` asks the same question of both.
    missingPrerequisites: missingPrerequisites(manifests, composed),
    missingVersionMetadata,
  };
}

/**
 * Append every binding a capability needs in this Worker to one environment's stanza.
 *
 * The entries are `project/bindingEntries.ts`'s, the same writer `pithy add` uses. Reconcile used to
 * carry its own copy, "kept in lockstep by intent" with `add`'s, and the two had already drifted: `add`
 * stamped a spec's `remote` flag and wrote the Workers AI binding, this did neither, so a capability
 * wired by `pithy upgrade` got a different config from the same manifest than one wired by `pithy add`.
 *
 * The KV name proposal the writer returns is dropped here on purpose: `upgrade` reports drift, and a KV
 * namespace title is something `pithy add` tells the adopter to create at the moment they compose the
 * capability, not something a later reconcile can act on.
 */
function appendBindings(
  stanza: WranglerStanza,
  manifest: CapabilityManifest,
  scope: BindingScope,
  composed: Capability | undefined,
): { written: MissingBinding[]; skipped: SkippedBinding[] } {
  const written: MissingBinding[] = [];
  const skipped: SkippedBinding[] = [];
  // Same source of truth as the plan — see `effectiveBindings`. Writing from the manifest here while the
  // plan reported from the composed instance would make `upgrade` decline to write the binding it had
  // just told the adopter was missing.
  for (const binding of effectiveBindings(manifest, composed)) {
    const write = appendBinding(stanza, binding, scope);
    // `present` and `unsupported` are neither: the first is idempotency (the plan already excluded it),
    // the second a kind with no array to be missing from, which `computeMissingBindings` skips too.
    if (write.outcome === "written") written.push({ env: scope.env, name: binding.name, type: binding.type });
    if (write.outcome === "skipped") {
      skipped.push({ env: scope.env, name: binding.name, type: binding.type, reason: write.reason });
    }
  }
  return { written, skipped };
}

/**
 * Render one option's `// describe` + `key: default` lines at a given indent — the same two lines
 * `pithy add` renders, through the same function, because "matching `pithy add`" was a comment and not
 * a mechanism. This called `JSON.stringify` while `add` called `renderConfigValue`, so one manifest
 * default came out as `{"code":"chips"}` here and `{ code: "chips" }` there, and only the second
 * survived the `biome check` a scaffolded project runs on itself (#171).
 */
function renderKeyLines(keys: MissingConfigKey[], indent: string): string {
  const lines: string[] = [];
  for (const key of keys) {
    lines.push(renderConfigOptionComment(key.describe, indent));
    lines.push(renderConfigOptionLine(key.key, key.constant ? { constant: key.constant } : key.default, indent));
  }
  return lines.join("\n");
}

/**
 * Convert a one-liner `name(),` registration to block form, inserting the missing keys.
 *
 * The call is rendered by core, not written here: it is the third place a capability's name reaches
 * generated source, and `pithy add`'s two were the ones #183 was reported about. No trailing comma —
 * the regex below matches `name()` and leaves the file's own separating comma alone.
 */
function convertOneLiner(source: string, name: string, indent: string, keys: MissingConfigKey[]): string {
  const block = renderCapabilityRegistration({
    name,
    indent,
    optionLines: [renderKeyLines(keys, `${indent}  `)],
    trailingComma: false,
  });
  // `indent` is the indent this very regex captured when the registration was located, so the block
  // carries its own opening indent and the match is replaced whole.
  const re = new RegExp(`^[ \\t]*${escapeRegExp(name)}[ \\t]*\\(\\s*\\)`, "m");
  // A replacement function keeps any `$` in the rendered defaults literal.
  return source.replace(re, () => block);
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
  // One space stands in for the indent: an inline block has no line of its own to sit on. The value is
  // rendered by the same function as every other writer's, so a hand-written block gets Biome's shape
  // too — the whole point of there being one renderer (#171).
  const inline = keys
    .map((key) => renderConfigOptionLine(key.key, key.constant ? { constant: key.constant } : key.default, " "))
    .join("");
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
  /**
   * The Cloudflare account this project belongs to, or `null` when it names none. Required (#234) — this
   * is the write side, and `migrate` on a non-`dev` env runs the project's migrations against a live
   * schema in whichever account the credentials belong to.
   */
  account: CloudflareAccountSelection | null;
  /** Test seam: run migrations without a real Miniflare/D1 run. */
  runMigrate?: RunMigrate;
}

/** What one capability's apply changed: the bindings and config keys actually added. */
export interface CapabilityApplied {
  /** The capability's short name. */
  name: string;
  /**
   * The bindings added to wrangler.jsonc for this capability — **read back off the writer**, one entry
   * per environment actually written.
   *
   * This used to be `cap.missingBindings`: the plan, copied across verbatim the moment the apply loop
   * touched the capability at all. So a binding the writer declined was counted as added, by a command
   * whose whole job is to be believed about what it just changed (#318).
   */
  addedBindings: MissingBinding[];
  /** The bindings this capability needed that the writer could not compose, each with its reason. */
  skippedBindings: SkippedBinding[];
  /** The config option keys inserted into this capability's pithy.config.ts registration. */
  addedConfigKeys: string[];
}

/** The summary {@link applyReconcilePlan} returns — what was written, what was skipped, whether migrations ran. */
export interface ReconcileApplied {
  /** The Worker this apply targeted, carried through from the plan so a fan-out report can label it. */
  worker: string;
  /**
   * The same Worker's deployed script name, carried through from the plan beside `worker`.
   *
   * **Both names, or the payload changes shape with a flag.** `pithy upgrade --json` reports
   * `applied ?? plan` out of one `workers` array, so a key the plan carried and the apply dropped meant a
   * consumer that read `deployedAs` worked under `--dry-run` and got `undefined` on the run that actually
   * wrote something — the mode where being sure which script was reconciled matters most. #231.
   */
  deployedAs: string;
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
  capabilities: readonly Capability[],
): Promise<Map<string, { written: MissingBinding[]; skipped: SkippedBinding[] }>> {
  const added = new Map<string, { written: MissingBinding[]; skipped: SkippedBinding[] }>();
  const caps = plan.perCapability.filter((cap) => cap.missingBindings.length > 0);
  if (caps.length === 0) return added;

  const byName = new Map((await availableManifests(projectDir)).manifests.map((manifest) => [manifest.name, manifest]));
  const composedByName = new Map(capabilities.map((capability) => [capability.name, capability]));
  const config = (await readWranglerConfig(workerDir)) as WranglerStanza;
  const stanzas = envStanzas(config);
  let touched = false;
  for (const cap of caps) {
    const manifest = byName.get(cap.name);
    if (!manifest) continue; // installed manifest vanished — nothing to wire
    // Each stanza is written for the environment it *is*, so the name it proposes has that environment
    // in it. `envStanzas` already pairs them on the read side; the write side uses the same pairing.
    const written: MissingBinding[] = [];
    const skipped: SkippedBinding[] = [];
    for (const { env, stanza } of stanzas) {
      const result = appendBindings(
        stanza,
        manifest,
        { ...(project === undefined ? {} : { project }), env, capability: manifest.name },
        composedByName.get(cap.name),
      );
      written.push(...result.written);
      skipped.push(...result.skipped);
    }
    appendDurableObjectMigrations(config, manifest.requiredBindings);
    added.set(cap.name, { written, skipped });
    // Only a real write dirties the file. A capability whose every binding was declined leaves
    // `wrangler.jsonc` byte-identical, and rewriting it would be a diff saying nothing happened.
    if (written.length > 0) touched = true;
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

  const addedBindings = await applyBindings(projectDir, workerDir, plan, options.project, capabilities);
  const addedConfigKeys = await applyConfigKeys(workerDir, plan);
  // Idempotent, and a no-op on a Worker that already declares it — including one that names a different
  // binding, which is reported rather than repointed.
  const addedVersionMetadata = plan.missingVersionMetadata ? await applyVersionMetadata(workerDir) : false;

  const perCapability: CapabilityApplied[] = [];
  for (const cap of plan.perCapability) {
    const bindings = addedBindings.get(cap.name) ?? { written: [], skipped: [] };
    const keys = addedConfigKeys.get(cap.name) ?? [];
    // A capability that wrote nothing but skipped something still belongs in the report — that is the
    // whole point of naming a skip. Silence here is the shape #318 was reported about.
    if (bindings.written.length === 0 && bindings.skipped.length === 0 && keys.length === 0) continue;
    perCapability.push({
      name: cap.name,
      addedBindings: bindings.written,
      skippedBindings: bindings.skipped,
      addedConfigKeys: keys,
    });
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
      account: options.account,
      project: migrateAs,
    });
    migrated = true;
  }

  return {
    worker: plan.worker,
    deployedAs: plan.deployedAs,
    perCapability,
    ejectedSkipped: plan.ejectedSkipped,
    migrated,
    migrations,
    addedVersionMetadata,
  };
}
