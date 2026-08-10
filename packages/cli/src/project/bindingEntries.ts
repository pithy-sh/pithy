// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import { isValidEnvironment } from "@pithy-sh/core/src/naming/environment";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { workflowScriptName } from "@pithy-sh/core/src/workflow/naming";

/**
 * One writer for the `wrangler.jsonc` entry a capability's binding needs, and one reader for whether a
 * stanza already has it.
 *
 * `capabilities/add.ts` and `capabilities/reconcile.ts` each carried their own copy of both, "kept in
 * lockstep by intent" — and intent is not a mechanism. They already disagreed: `add` stamped a spec's
 * `remote` flag and wrote the Workers AI binding, `reconcile` did neither, so the same manifest produced
 * two different configs depending on whether the capability arrived through `pithy add` or through
 * `pithy upgrade`. This module is the mechanism, so the drift has nowhere to live.
 *
 * The rule for what belongs here is {@link isWrittenBinding}: a kind is written when every field
 * wrangler's validator requires is derivable offline. Everything else — a Vectorize `index_name`, a
 * Secrets Store entry — is a provisioner's to write, and a partial entry would be worse than none
 * because wrangler refuses to load the file at all.
 */

/** A binding entry as wrangler files it: the name, plus whatever the spec can state offline. */
interface BindingEntry {
  binding: string;
  database_name?: string;
  remote?: boolean;
}

/** A single Durable Object namespace binding, as wrangler writes it. */
interface DurableObjectBinding {
  name: string;
  class_name: string;
  remote?: boolean;
}

/**
 * One `ratelimits` entry. `name` is the binding — wrangler spells this one differently from every other
 * array, which is its own reason for there being a single writer.
 */
interface RateLimitBinding {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
}

/** One `workflows` entry on the **app** Worker: a cross-script binding into the capability's host. */
interface WorkflowBindingEntry {
  binding: string;
  name: string;
  class_name: string;
  script_name: string;
}

/** A Durable Object class migration — a versioned tag registering (or dropping) DO classes. */
interface DurableObjectMigration {
  tag: string;
  new_sqlite_classes?: string[];
}

/**
 * The binding arrays of one wrangler stanza — every key this module touches. `durable_objects.bindings`
 * is per-environment (each environment gets its own DO namespace); DO class `migrations` are **top-level
 * only** (they register the class against the script, not per-environment), so they live on the root
 * config — see {@link appendDurableObjectMigrations}.
 *
 * `ai` is a single object, not an array: a Worker has exactly one Workers AI binding.
 */
export interface WranglerStanza {
  d1_databases?: BindingEntry[];
  kv_namespaces?: BindingEntry[];
  r2_buckets?: BindingEntry[];
  ai?: BindingEntry;
  ratelimits?: RateLimitBinding[];
  workflows?: WorkflowBindingEntry[];
  durable_objects?: { bindings: DurableObjectBinding[] };
  migrations?: DurableObjectMigration[];
  env?: Record<string, WranglerStanza | undefined>;
}

/** A `<project>-<env>-<binding>` name proposed for a resource the adopter creates themselves. */
export interface ProposedName {
  /** The Worker env binding the name is proposed for (e.g. `SESSIONS`). */
  binding: string;
  /** The environment whose stanza declares it — `dev` for the top-level one. */
  env: string;
  /** The proposed resource name, composed by the one naming rule: `<project>-<env>-<binding>`. */
  name: string;
}

/** Which capability, project, and environment a stanza's entries are composed for. */
export interface BindingScope {
  /** The project name, or absent when none was resolved — in which case nothing is proposed or derived. */
  project?: string;
  /** The environment this stanza *is* — `dev` for the top-level one, else the `env.<name>` key. */
  env: string;
  /** The capability the bindings belong to — the `<capability>` segment of a Workflow's deployed names. */
  capability: string;
}

/** The single DO class-migration tag Pithy scaffolds under. New DO classes merge into it at add time. */
const DO_MIGRATION_TAG = "v1";

/**
 * The rate-limit policy a `ratelimit` binding is written with: **100 requests per 60 seconds, per client
 * IP**.
 *
 * A tier-1 edge limiter is a flood guard, not a product rule — `@pithy-sh/auth`'s middleware says so
 * itself ("the limit and window are set on the binding in `wrangler.jsonc`, not here"), and the per-action
 * caps that *are* a product rule live in Better Auth's D1 limiter one tier down. So the number belongs in
 * the adopter's config where they can tune it, and the only question here is what it starts at.
 *
 * 100/60 is high enough that no human hits it and low enough to blunt credential stuffing. `period` is not
 * free-form: Cloudflare accepts **10 or 60 only**, so a "sensible" 300 would be a config wrangler refuses.
 */
const RATE_LIMIT_REQUESTS = 100;
const RATE_LIMIT_PERIOD_SECONDS = 60;

/**
 * The `namespace_id` for a rate limiter, derived from its binding name.
 *
 * Cloudflare has the adopter choose this, and it is the counter's identity: two bindings sharing one id
 * share one budget. Deriving it from the binding name rather than counting entries is what makes the
 * value **stable** — the same across environments, across a re-add, across `pithy upgrade` retrofitting an
 * older project, and independent of the order capabilities were composed in. A positional counter would
 * renumber every limiter the moment one was removed, silently merging two budgets.
 *
 * Four digits, from an FNV-1a hash: numeric because every Cloudflare example is, and bounded because the
 * id is a label rather than an address. Two different bindings colliding would share one budget — a
 * limiter that trips sooner than its own traffic explains — which is why it is worth saying that no
 * shipped capability declares a second rate limiter, and that this is the line to revisit when one does.
 */
export function rateLimitNamespaceId(binding: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < binding.length; i++) {
    hash ^= binding.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return String(1000 + (hash % 9000));
}

/**
 * Stamp the spec's `remote` flag onto an emitted entry. An unset `remote` writes no key at all: the
 * capability has no opinion, and an explicit `remote: false` would pin the binding to local emulation the
 * adopter may well want to override.
 */
function withRemote<Entry extends object>(entry: Entry, binding: BindingSpec): Entry {
  return binding.remote === undefined ? entry : { ...entry, remote: binding.remote };
}

/**
 * The `<project>-<env>-<binding>` name to propose for a binding, or `undefined` when there is nothing safe
 * to propose.
 *
 * **Through the facade, per namespace.** A D1 database and a KV namespace are different Cloudflare
 * namespaces with different limits — no published cap and 512 respectively — and calling the generic
 * composer held both to 63, which is R2's number and only R2's.
 *
 * Two cases propose nothing rather than guessing. No project name: a guessed prefix is worse than none,
 * since every command that later recomputes the name would compute a different one. And an `env.<key>` the
 * naming scheme does not accept — an eleven-character environment eats the room every project name was
 * already accepted against, so no name for it is honest. The binding is still wired either way.
 */
function proposeName(scope: BindingScope, binding: string, kind: "d1" | "kv"): string | undefined {
  if (scope.project === undefined || !isValidEnvironment(scope.env)) return undefined;
  return resourceNames(scope.project).env(scope.env)[kind](binding);
}

/**
 * The complete `workflows` entry for a binding, or `undefined` when it cannot be named honestly.
 *
 * Every field wrangler requires is derived rather than guessed: `name` is the deployed Workflow
 * (`<project>-<env>-<capability>-<job>`, through core's own composer, so it is byte-identical to what the
 * capability's provisioner deploys under), `class_name` is the exported `WorkflowEntrypoint` the manifest
 * states, and `script_name` is the capability's host Worker — a cross-script binding, because the class
 * lives in the host and never in the app.
 *
 * `script_name` goes through the naming facade's `worker` kind, so it is held to a Worker's 63 rather than
 * a Workflow's 64. The one-character gap is real, and it is the one that survives an adopter enabling
 * workers.dev. Same call `project/appBindings.ts` makes at provision time, so the two writers cannot
 * disagree about the same Worker.
 *
 * A binding with no `job` or no `className` is not writable: wrangler rejects a `workflows` entry missing
 * either, so emitting a partial one would trade a failed request for a config that will not load.
 * `capabilities/requiredBindings.test.ts` is what makes that a build failure rather than a surprise.
 */
function workflowEntry(scope: BindingScope, binding: BindingSpec): WorkflowBindingEntry | undefined {
  const { project, env, capability } = scope;
  if (project === undefined || !isValidEnvironment(env)) return undefined;
  if (binding.job === undefined || binding.className === undefined) return undefined;
  return {
    binding: binding.name,
    name: workflowScriptName({ project, capability, job: binding.job, env }),
    class_name: binding.className,
    script_name: resourceNames(project).env(env).worker(capability),
  };
}

/**
 * Whether a stanza already declares a binding. `null` means the kind has no `wrangler.jsonc` array this
 * module writes — a `secret`, a `vectorize` index, a `queue`, an `email` send binding, a `service` — so
 * there is nothing to look for and nothing to report missing.
 *
 * The presence check keys on the **binding name alone**, deliberately. Comparing the derived value too
 * would read an adopter's renamed database, retuned rate limit, or repointed Workflow as a missing
 * binding, and the writer would append a second entry for a binding wrangler already has.
 */
export function stanzaHasBinding(stanza: WranglerStanza, binding: BindingSpec): boolean | null {
  switch (binding.type) {
    case "d1":
      return (stanza.d1_databases ?? []).some((entry) => entry.binding === binding.name);
    case "kv":
      return (stanza.kv_namespaces ?? []).some((entry) => entry.binding === binding.name);
    case "r2":
      return (stanza.r2_buckets ?? []).some((entry) => entry.binding === binding.name);
    case "ai":
      return stanza.ai !== undefined;
    case "durable_object":
      return (stanza.durable_objects?.bindings ?? []).some((entry) => entry.name === binding.name);
    case "ratelimit":
      return (stanza.ratelimits ?? []).some((entry) => entry.name === binding.name);
    case "workflow":
      return (stanza.workflows ?? []).some((entry) => entry.binding === binding.name);
    default:
      return null;
  }
}

/**
 * Append one binding's entry to a stanza, in place, unless the binding is already there.
 *
 * The writer emits a binding's **shape** — its name, and whatever the spec and the naming rule can state
 * offline. Resource identity that only provisioning knows stays absent: `database_id`, `id`, and
 * `bucket_name` are filled later by `pithy provision` or the capability's own provisioner. `database_name`
 * is the exception and it is a *proposal*, not an identity — wrangler accepts a D1 entry naming a database
 * that does not exist yet, and an adopter who leaves it alone gets a project-scoped name instead of
 * inventing `db`.
 *
 * Returns the KV namespace title to propose, when this call wrote a KV binding and a name could be
 * composed. **KV is reported rather than written, because wrangler has nowhere to write it**: a
 * `kv_namespaces` entry takes `binding`, `id`, `preview_id`, and `remote`, with no title field, so the name
 * lives only in the account.
 */
export function appendBinding(
  stanza: WranglerStanza,
  binding: BindingSpec,
  scope: BindingScope,
): ProposedName | undefined {
  if (stanzaHasBinding(stanza, binding) !== false) return undefined;

  switch (binding.type) {
    case "d1": {
      stanza.d1_databases ??= [];
      const name = proposeName(scope, binding.name, "d1");
      stanza.d1_databases.push(
        withRemote({ binding: binding.name, ...(name ? { database_name: name } : {}) }, binding),
      );
      return undefined;
    }
    case "kv": {
      stanza.kv_namespaces ??= [];
      stanza.kv_namespaces.push(withRemote({ binding: binding.name }, binding));
      const name = proposeName(scope, binding.name, "kv");
      return name ? { binding: binding.name, env: scope.env, name } : undefined;
    }
    case "r2":
      stanza.r2_buckets ??= [];
      stanza.r2_buckets.push(withRemote({ binding: binding.name }, binding));
      return undefined;
    case "ai":
      // A Worker gets exactly one Workers AI binding, so `ai` is an object rather than an array. An
      // existing one is left alone by the presence check above: it is either this capability's
      // (idempotency) or an adopter's deliberate choice of binding name, and clobbering either would
      // break their Worker.
      stanza.ai = withRemote({ binding: binding.name }, binding);
      return undefined;
    case "durable_object":
      if (binding.className === undefined) return undefined;
      stanza.durable_objects ??= { bindings: [] };
      stanza.durable_objects.bindings ??= [];
      stanza.durable_objects.bindings.push(withRemote({ name: binding.name, class_name: binding.className }, binding));
      return undefined;
    case "ratelimit":
      stanza.ratelimits ??= [];
      stanza.ratelimits.push({
        name: binding.name,
        namespace_id: rateLimitNamespaceId(binding.name),
        simple: { limit: RATE_LIMIT_REQUESTS, period: RATE_LIMIT_PERIOD_SECONDS },
      });
      return undefined;
    case "workflow": {
      const entry = workflowEntry(scope, binding);
      if (entry === undefined) return undefined;
      stanza.workflows ??= [];
      stanza.workflows.push(entry);
      return undefined;
    }
    default:
      // `queue`, `email`, `secret`, `service`, and `vectorize`. Nothing is emitted, and for two different
      // reasons: a `secret` has no wrangler array at all, and a `vectorize` entry needs the provisioned
      // `index_name` — wrangler's validator requires it, so a binding-only entry stops `wrangler dev` and
      // `wrangler deploy` both. `capabilities/requiredBindings.test.ts` fails any capability that requires
      // a kind neither this writer nor a provisioner covers.
      return undefined;
  }
}

/**
 * Register a capability's Durable Object classes in the **top-level** `migrations` array — the class
 * migration tag, distinct from D1 (Kysely) migrations and from the per-environment DO bindings.
 *
 * `new_sqlite_classes`, not `new_classes`, deliberately: a Pithy session object stores its state in
 * SQLite-backed DO storage, and `new_classes` would provision a key-value backend that silently cannot run
 * SQL — the well-known DO footgun. All classes merge into one tag (`v1`) at add time. **Note:** adding a
 * DO class to a Worker that has *already deployed* `v1` needs a *new* tag; this scaffolds the first-add
 * case, which is the only one Pithy has today.
 */
export function appendDurableObjectMigrations(config: WranglerStanza, bindings: readonly BindingSpec[]): void {
  const classes = bindings
    .filter((binding) => binding.type === "durable_object" && binding.className !== undefined)
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

/**
 * Every environment's binding stanza, paired with the environment it *is*: the top-level one (the dev
 * environment) plus each `env.<name>`.
 *
 * The pairing is the point. Both writers used to walk `Object.values(config.env)` and drop the key, which
 * was harmless while an entry carried nothing but its binding — and wrong the moment a name has the
 * environment in it, which is every proposed database name and every Workflow entry.
 */
export function envStanzas(config: WranglerStanza): { env: string; stanza: WranglerStanza }[] {
  const list: { env: string; stanza: WranglerStanza }[] = [{ env: "dev", stanza: config }];
  for (const [env, stanza] of Object.entries(config.env ?? {})) {
    if (stanza) list.push({ env, stanza });
  }
  return list;
}
