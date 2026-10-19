// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type BindingSpec, type BindingType, TARGET_KINDS } from "@pithy-sh/core/src/capability/bindings";
import { GLOBAL_SCOPE, isValidEnvironment } from "@pithy-sh/core/src/naming/environment";
import { bindingResourceName } from "@pithy-sh/core/src/naming/provisionScope";
import { resourceNames } from "@pithy-sh/core/src/naming/resourceNames";
import { workflowScriptName } from "@pithy-sh/core/src/workflow/naming";
import { z } from "zod";

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

/** One entry of an array-shaped carried kind: the binding, and the resource it addresses where it states one. */
interface CarriedEntry {
  binding: string;
  [field: string]: string | boolean;
}

/** One `queues.producers` entry: the binding, and the queue `pithy provision` creates under that name. */
interface QueueProducer {
  binding: string;
  queue?: string;
  remote?: boolean;
}

/** One `artifacts` entry: the binding, and the namespace of repositories it addresses in this environment. */
export interface ArtifactsEntry {
  binding: string;
  namespace?: string;
  remote?: boolean;
}

/** One `send_email` entry. `name` is the binding, as in `ratelimits`; the rest is the adopter's routing. */
interface SendEmailBinding {
  name: string;
  [field: string]: unknown;
}

/**
 * A Durable Object class migration — a versioned tag registering (or dropping) DO classes. The kit writes
 * only `new_sqlite_classes`; the other verbs are read, because an adopter writes them by hand.
 */
interface DurableObjectMigration {
  tag: string;
  new_sqlite_classes?: string[];
  new_classes?: string[];
  renamed_classes?: { from: string; to: string }[];
  transferred_classes?: { from: string; from_script: string; to: string }[];
  deleted_classes?: string[];
}

/**
 * Every class a tag brings into the script, whichever verb brings it. A class an adopter created with
 * `new_classes`, renamed into place or transferred in already exists, and a second create for it is one
 * wrangler refuses (#662).
 */
function classesRegisteredBy(migration: DurableObjectMigration): string[] {
  return [
    ...(migration.new_sqlite_classes ?? []),
    ...(migration.new_classes ?? []),
    ...(migration.renamed_classes ?? []).map((rename) => rename.to),
    ...(migration.transferred_classes ?? []).map((transfer) => transfer.to),
  ];
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
  browser?: { binding: string; remote?: boolean };
  images?: { binding: string; remote?: boolean };
  hyperdrive?: CarriedEntry[];
  analytics_engine_datasets?: CarriedEntry[];
  pipelines?: CarriedEntry[];
  mtls_certificates?: CarriedEntry[];
  dispatch_namespaces?: CarriedEntry[];
  queues?: { producers?: QueueProducer[]; consumers?: unknown[] };
  send_email?: SendEmailBinding[];
  artifacts?: ArtifactsEntry[];
  ratelimits?: RateLimitBinding[];
  workflows?: WorkflowBindingEntry[];
  durable_objects?: { bindings: DurableObjectBinding[] };
  migrations?: DurableObjectMigration[];
  env?: Record<string, WranglerStanza | undefined>;
}

/**
 * **The `wrangler.jsonc` key each binding kind lives under, spelled the way wrangler spells it (#662).**
 *
 * The one table from a {@link BindingType} to the file. `project/wranglerInheritance.ts` derives what a new stanza
 * carries from it and `seedPolicy`, and `wranglerInheritance.test.ts` holds every value to a key wrangler does not
 * inherit — which is every key a binding lives in, and the reason a stanza has to be told what to start with.
 * Total, so a kind added to `BindingType` without its key is a type error here.
 */
export const WRANGLER_KEYS: Readonly<Record<BindingType, string>> = {
  d1: "d1_databases",
  kv: "kv_namespaces",
  r2: "r2_buckets",
  ai: "ai",
  vectorize: "vectorize",
  queue: "queues",
  ratelimit: "ratelimits",
  email: "send_email",
  secret: "secrets_store_secrets",
  workflow: "workflows",
  service: "services",
  durable_object: "durable_objects",
  hyperdrive: "hyperdrive",
  browser: "browser",
  images: "images",
  analytics_engine_datasets: "analytics_engine_datasets",
  pipelines: "pipelines",
  mtls_certificates: "mtls_certificates",
  dispatch_namespaces: "dispatch_namespaces",
  artifacts: "artifacts",
};

/** The array-shaped carried kinds, each an entry of `binding` plus the field its `target` is written as. */
type CarriedArrayKind =
  | "hyperdrive"
  | "analytics_engine_datasets"
  | "pipelines"
  | "mtls_certificates"
  | "dispatch_namespaces";

/**
 * What one call to {@link appendBinding} did.
 *
 * **The writer answers "did I write it", because nothing else can.** `pithy upgrade` used to report the
 * bindings its *plan* named and never asked the writer whether any of them landed, so five capabilities'
 * Workflow bindings were counted as added, silently declined, and correctly reported missing by `pithy
 * doctor` seconds later (#318). A count derived from an intention is a claim about the future; this is
 * the return value that makes it a claim about the file.
 *
 * `skipped` carries a `reason` written for an operator reading a terminal, not for a log: it names what
 * the entry needed and did not have, so the next step is obvious.
 */
export type BindingWrite =
  /** An entry was appended to the stanza. `proposed` is set only for KV, whose title wrangler cannot hold. */
  | { outcome: "written"; proposed?: ProposedName }
  /** The stanza already declares this binding. Left exactly as the adopter has it. */
  | { outcome: "present" }
  /** A kind this module writes no array for — a `secret`, a `vectorize` index, a `service`. */
  | { outcome: "unsupported" }
  /** The entry could not be composed honestly. Nothing was written, and this says what was missing. */
  | { outcome: "skipped"; reason: string };

/** A name proposed for a resource the adopter creates themselves, composed by the one naming rule. */
export const ProposedName = z
  .object({
    binding: z.string().describe("The Worker env binding the name is proposed for, e.g. `SESSIONS`."),
    env: z.string().describe("The environment whose stanza declares it — `dev` for the top-level one."),
    // `<project>-global-<thing>` where the binding declares its resource the project's rather than the
    // environment's (#513).
    name: z.string().describe("The proposed resource name, `<project>-<env>-<thing>`."),
  })
  .describe("A name proposed for a resource the adopter creates themselves, composed by the one naming rule.");
export type ProposedName = z.infer<typeof ProposedName>;

/** Which capability, project, and environment a stanza's entries are composed for. */
export interface BindingScope {
  /** The project name, or absent when none was resolved — in which case nothing is proposed or derived. */
  project?: string;
  /** The environment this stanza *is* — `dev` for the top-level one, else the `env.<name>` key. */
  env: string;
  /** The capability the bindings belong to — the `<capability>` segment of a Workflow's deployed names. */
  capability: string;
}

/**
 * The prefix every DO class-migration tag Pithy allocates carries: `v1`, `v2`, … in add order.
 *
 * A tag names one step, and Cloudflare remembers the last one it applied — which is why the number
 * matters, and why {@link appendDurableObjectMigrations} never reuses one.
 */
const DO_MIGRATION_TAG_PREFIX = "v";

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
 * value **stable** — the same across environments, across a re-add, and independent of the order
 * capabilities were composed in. A positional counter would renumber every limiter the moment one was
 * removed, silently merging two budgets.
 *
 * **Stable is not retrofitted, and this docstring used to claim it was (#499).** It named `pithy upgrade`
 * retrofitting an older project among the things the derivation buys, and no command does that: a
 * limiter's stanza is written once at `pithy add` and never revisited, so a project scaffolded before this
 * function keeps the positional id it was given (`1001` where the kit now writes `3093`). Rewriting one is
 * not the obvious repair either — a `namespace_id` is a live budget's identity, so changing it
 * re-partitions a counter under running traffic. The value is left alone and the difference is
 * **reported**: {@link generatedFieldDrift} is what `pithy doctor` compares, and the adopter decides.
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

/** One field of a binding's `wrangler.jsonc` entry whose value the kit derives, beside what the entry holds. */
export interface GeneratedFieldDrift {
  /** The wrangler field, spelled the way wrangler spells it — `namespace_id`. */
  field: string;
  /** What {@link appendBinding} would write for this binding today. */
  expected: string;
  /** What this environment's stanza carries instead. */
  actual: string;
}

/**
 * Where an environment's stanza disagrees with the value this writer derives for a binding **today**.
 *
 * A generated value whose derivation changes is never retrofitted (#499): the entry was written once, and
 * every later command reads the binding by name alone — {@link stanzaHasBinding} says why, and it is right
 * to. So the only thing that can notice is a comparison, and this is it. Report-only by construction: it
 * returns a difference, it never writes one, because a `namespace_id` is a live budget's identity and the
 * adopter's number may be the one they meant.
 *
 * **One kind participates, and the boundary is not shyness — it is the difference between a value the kit
 * owns and a value the kit hands over.**
 *
 * - `ratelimit.namespace_id` is ours: the writer derives it from the binding name and nothing about a
 *   project changes it, so a different number can only mean the entry predates the derivation.
 * - `simple.limit` and `simple.period` are the adopter's, said out loud by the constants above — "the
 *   number belongs in the adopter's config where they can tune it". A tuned limiter reported as drift is
 *   the feature working being called a fault.
 * - A D1 `database_name` is a *proposal*, not a derivation. An adopter pointing a binding at a database
 *   they already had is the case it exists to allow.
 * - A `workflows` entry is fully derived and genuinely worth comparing — and already is, by
 *   `project/workflows.ts`, which doctor renders in its own `Workflows:` block. A second comparison of one
 *   fact is how two reports come to disagree about it.
 *
 * A binding the stanza does not carry yields nothing: that is a *missing* binding, which the reconcile
 * plan already reports and an upgrade already writes. So does an entry with no `namespace_id` at all —
 * wrangler refuses that file outright, and a report about the wrong number would bury the reason.
 */
export function generatedFieldDrift(stanza: WranglerStanza, binding: BindingSpec): GeneratedFieldDrift[] {
  if (binding.type !== "ratelimit") return [];
  const entry = (stanza.ratelimits ?? []).find((candidate) => candidate.name === binding.name);
  // `String(…)`, because this stanza is the adopter's hand-editable JSONC read through a cast: wrangler
  // wants the id quoted, and an unquoted `3093` there must compare as the same value rather than as drift.
  if (entry?.namespace_id === undefined) return [];
  const expected = rateLimitNamespaceId(binding.name);
  const actual = String(entry.namespace_id);
  return actual === expected ? [] : [{ field: "namespace_id", expected, actual }];
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
 * The name to propose for a binding's resource, or `undefined` when there is nothing safe to propose.
 *
 * **Not always `<project>-<env>-<binding>`, and that is #513.** A binding whose manifest says its
 * resource is the project's rather than the environment's composes `<project>-global-<thing>`, so every
 * environment's stanza names the identical resource — which is what `EMAIL_SUPPRESSIONS` requires and
 * what this writer had no way to say. It wrote three per-environment suppression databases, `pithy email
 * provision` created the one global one, and an unsubscribe recorded through either was invisible to the
 * other. The spec is taken whole rather than by name for exactly that: the answer is on it.
 *
 * **Through the same composer a provisioning run uses**, so the two writers cannot disagree about one
 * resource. The scoped half stays here as a callback because only this writer knows which stanza it is
 * filling in.
 *
 * **Through the facade, per namespace.** A D1 database and a KV namespace are different Cloudflare
 * namespaces with different limits — no published cap and 512 respectively — and calling the generic
 * composer held both to 63, which is R2's number and only R2's.
 *
 * Two cases propose nothing rather than guessing. No project name: a guessed prefix is worse than none,
 * since every command that later recomputes the name would compute a different one. And an `env.<key>`
 * the naming scheme does not accept — an eleven-character environment eats the room every project name
 * was already accepted against, so no name for it is honest. The binding is still wired either way.
 *
 * **The environment guard sits below the global branch, deliberately.** A global name has no environment
 * segment in it at all, so an `env.<key>` the scheme refuses is no reason to withhold one: refusing it
 * there would leave that stanza the single stanza pointing at nothing, in the one case where every
 * stanza has to point at the same thing.
 */
function proposeName(scope: BindingScope, binding: BindingSpec, kind: "d1" | "kv" | "queue"): string | undefined {
  const { project } = scope;
  if (project === undefined) return undefined;
  if (binding.scope !== GLOBAL_SCOPE && !isValidEnvironment(scope.env)) return undefined;
  const names = resourceNames(project);
  return bindingResourceName(project, binding.name, kind, binding, (thing) => names.env(scope.env)[kind](thing));
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
 * **This writer has one shape, and it is the cross-Worker one.** A capability's Workflow class is
 * exported by that capability's host Worker, never by the app, so there is no same-Worker branch here to
 * be missing — #318 guessed there was. The same-Worker shape (`class_name`, no `script_name`) is a
 * different writer for a different owner: `project/appWorkflows.ts`, for jobs the adopter's **own** app
 * capability declares and its own script exports. Looking for it here finds a case this file will never
 * see.
 *
 * A binding with no `job` or no `className` is not writable: wrangler rejects a `workflows` entry missing
 * either, so emitting a partial one would trade a failed request for a config that will not load.
 * `capabilities/requiredBindings.test.ts` is what makes that a build failure rather than a surprise.
 *
 * **Each refusal says why.** Returning a bare `undefined` is what let `pithy upgrade` count these as
 * written (#318): the caller had nothing to distinguish "wrote it" from "declined", so it reported the
 * plan. The reason is the operator's next step, in their words — the missing field, or the missing
 * project name.
 */
function workflowEntry(scope: BindingScope, binding: BindingSpec): WorkflowBindingEntry | { reason: string } {
  const { project, env, capability } = scope;
  if (project === undefined) return { reason: "no project name is resolved" };
  if (!isValidEnvironment(env)) return { reason: `the naming scheme does not accept the environment "${env}"` };
  if (binding.job === undefined || binding.className === undefined) {
    return { reason: `${binding.name} declares no ${binding.job === undefined ? "job" : "className"}` };
  }
  return {
    binding: binding.name,
    name: workflowScriptName({ project, capability, job: binding.job, env }),
    class_name: binding.className,
    script_name: resourceNames(project).env(env).worker(capability),
  };
}

/**
 * Whether a stanza already declares a binding. `null` means the kind has no `wrangler.jsonc` array this
 * module writes — a `secret`, a `vectorize` index, a `service` — so there is nothing to look for and nothing
 * to report missing.
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
    case "queue":
      return (stanza.queues?.producers ?? []).some((entry) => entry.binding === binding.name);
    case "email":
      return (stanza.send_email ?? []).some((entry) => entry.name === binding.name);
    case "artifacts":
      return (stanza.artifacts ?? []).some((entry) => entry.binding === binding.name);
    case "browser":
    case "images":
      // One per Worker, an object like `ai`, but present only under this name: `validateBindings` reads
      // `env[binding.name]`, so one bound as anything else leaves this binding unbound at boot.
      return stanza[binding.type]?.binding === binding.name;
    case "hyperdrive":
    case "analytics_engine_datasets":
    case "pipelines":
    case "mtls_certificates":
    case "dispatch_namespaces":
      return (stanza[binding.type] ?? []).some((entry) => entry.binding === binding.name);
    default:
      return null;
  }
}

/**
 * The entry for an array-shaped carried kind: the binding, the account-level resource written into the field
 * wrangler names for it, and the spec's `remote` where wrangler takes one. `BindingSpec` refuses a kind that
 * requires a `target` without one, so a missing one here is a dataset left to wrangler's default.
 */
function carriedEntry(binding: BindingSpec, kind: CarriedArrayKind): CarriedEntry {
  const field = TARGET_KINDS[kind]?.field;
  const entry: CarriedEntry = { binding: binding.name };
  if (field !== undefined && binding.target !== undefined) entry[field] = binding.target;
  // Analytics Engine and Hyperdrive take no `remote`; wrangler refuses the key on both.
  return kind === "analytics_engine_datasets" || kind === "hyperdrive" ? entry : withRemote(entry, binding);
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
 * Returns {@link BindingWrite} — **what happened**, not what was meant to. The KV namespace title rides
 * on a `written` outcome, when this call wrote a KV binding and a name could be composed: **KV is
 * reported rather than written, because wrangler has nowhere to write it**, since a `kv_namespaces` entry
 * takes `binding`, `id`, `preview_id`, and `remote`, with no title field, so the name lives only in the
 * account.
 */
export function appendBinding(stanza: WranglerStanza, binding: BindingSpec, scope: BindingScope): BindingWrite {
  const has = stanzaHasBinding(stanza, binding);
  if (has === null) return { outcome: "unsupported" };
  if (has) return { outcome: "present" };

  switch (binding.type) {
    case "d1": {
      stanza.d1_databases ??= [];
      const name = proposeName(scope, binding, "d1");
      stanza.d1_databases.push(
        withRemote({ binding: binding.name, ...(name ? { database_name: name } : {}) }, binding),
      );
      return { outcome: "written" };
    }
    case "kv": {
      stanza.kv_namespaces ??= [];
      stanza.kv_namespaces.push(withRemote({ binding: binding.name }, binding));
      const name = proposeName(scope, binding, "kv");
      return name
        ? { outcome: "written", proposed: { binding: binding.name, env: scope.env, name } }
        : { outcome: "written" };
    }
    case "r2":
      stanza.r2_buckets ??= [];
      stanza.r2_buckets.push(withRemote({ binding: binding.name }, binding));
      return { outcome: "written" };
    case "ai":
      // A Worker gets exactly one Workers AI binding, so `ai` is an object rather than an array. An
      // existing one is left alone by the presence check above: it is either this capability's
      // (idempotency) or an adopter's deliberate choice of binding name, and clobbering either would
      // break their Worker.
      stanza.ai = withRemote({ binding: binding.name }, binding);
      return { outcome: "written" };
    case "durable_object":
      // `BindingSpec` refuses a classless DO binding at define and at manifest parse, so this is the
      // second wall rather than the first. It still says why, because a writer that returns nothing
      // teaches its caller to report the plan.
      if (binding.className === undefined)
        return { outcome: "skipped", reason: `${binding.name} declares no className` };
      stanza.durable_objects ??= { bindings: [] };
      stanza.durable_objects.bindings ??= [];
      stanza.durable_objects.bindings.push(withRemote({ name: binding.name, class_name: binding.className }, binding));
      return { outcome: "written" };
    case "ratelimit":
      stanza.ratelimits ??= [];
      stanza.ratelimits.push({
        name: binding.name,
        namespace_id: rateLimitNamespaceId(binding.name),
        simple: { limit: RATE_LIMIT_REQUESTS, period: RATE_LIMIT_PERIOD_SECONDS },
      });
      return { outcome: "written" };
    case "workflow": {
      const entry = workflowEntry(scope, binding);
      if ("reason" in entry) return { outcome: "skipped", reason: entry.reason };
      stanza.workflows ??= [];
      stanza.workflows.push(entry);
      return { outcome: "written" };
    }
    case "queue": {
      // The queue `pithy provision` creates, named by the same composer. A producer naming no queue is an entry
      // `wrangler deploy` cannot bind, so a queue this cannot name is skipped and said, never half-written.
      if (scope.project === undefined) return { outcome: "skipped", reason: "no project name is resolved" };
      const name = proposeName(scope, binding, "queue");
      if (name === undefined) {
        return { outcome: "skipped", reason: `the naming scheme does not accept the environment "${scope.env}"` };
      }
      stanza.queues ??= {};
      stanza.queues.producers ??= [];
      stanza.queues.producers.push(withRemote({ binding: binding.name, queue: name }, binding));
      return { outcome: "written" };
    }
    case "email":
      // The binding and nothing else. `destination_address` and `allowed_*` are where this environment's mail
      // may go, which is the adopter's to state per environment — `seedPolicy`'s `branch`, from the other end.
      stanza.send_email ??= [];
      stanza.send_email.push(withRemote({ name: binding.name }, binding));
      return { outcome: "written" };
    case "artifacts": {
      // `{ binding, namespace }`, and the namespace is this environment's, `<project>-<env>` (#673). An entry with
      // no namespace is one wrangler refuses, so a namespace this cannot name is skipped and said, never half-written.
      if (scope.project === undefined) return { outcome: "skipped", reason: "no project name is resolved" };
      if (!isValidEnvironment(scope.env)) {
        return { outcome: "skipped", reason: `the naming scheme does not accept the environment "${scope.env}"` };
      }
      stanza.artifacts ??= [];
      stanza.artifacts.push(
        withRemote(
          { binding: binding.name, namespace: resourceNames(scope.project).env(scope.env).artifactsNamespace() },
          binding,
        ),
      );
      return { outcome: "written" };
    }
    case "browser":
    case "images": {
      // One per Worker, like `ai`. One already bound under another name is the adopter's, and overwriting
      // it would unbind their code; the presence check above has reported this one missing, so say why.
      const existing = stanza[binding.type];
      if (existing !== undefined) {
        return {
          outcome: "skipped",
          reason: `this Worker already binds ${binding.type} as ${existing.binding}, and a Worker takes one`,
        };
      }
      stanza[binding.type] = withRemote({ binding: binding.name }, binding);
      return { outcome: "written" };
    }
    case "hyperdrive":
    case "analytics_engine_datasets":
    case "pipelines":
    case "mtls_certificates":
    case "dispatch_namespaces": {
      stanza[binding.type] ??= [];
      stanza[binding.type]?.push(carriedEntry(binding, binding.type));
      return { outcome: "written" };
    }
    default:
      // `secret`, `service`, and `vectorize`. Nothing is emitted, and for three different
      // reasons: a `secret` has no wrangler array at all, a `service` entry is `pithy provision`'s to write
      // out of the target Worker's scoped script name, and a `vectorize` entry needs the provisioned
      // `index_name` — wrangler's validator requires it, so a binding-only entry stops `wrangler dev` and
      // `wrangler deploy` both. `capabilities/requiredBindings.test.ts` fails any capability that requires
      // a kind neither this writer nor a provisioner covers. Unreachable: `stanzaHasBinding` already
      // returned `null` for every one of them above.
      return { outcome: "unsupported" };
  }
}

/**
 * Register a capability's Durable Object classes in the **top-level** `migrations` array — the class
 * migration tag, distinct from D1 (Kysely) migrations and from the per-environment DO bindings.
 *
 * `new_sqlite_classes`, not `new_classes`, deliberately: a Pithy session object stores its state in
 * SQLite-backed DO storage, and `new_classes` would provision a key-value backend that silently cannot run
 * SQL — the well-known DO footgun.
 *
 * **Every add that brings new classes allocates its own tag, and no tag is ever edited after it is
 * written.** A tag is applied once and remembered by Cloudflare: the next deploy sends only the tags
 * *after* the last one applied. So a class appended into a tag that has already been deployed is sent to
 * nobody — the namespace is never created, and the deploy fails on a binding to a class with no migration
 * behind it. Every class used to merge into a single `v1`, and the comment here said why that was safe:
 * `@pithy-sh/multiplayer` was the only capability shipping a Durable Object, so every add was a first add.
 * #415 made `@pithy-sh/matchmaking` addable, which ends that — and `pithy add multiplayer` → `pithy deploy`
 * → `pithy add matchmaking` is the path its own README recommends.
 *
 * Splitting costs a never-deployed Worker nothing: wrangler applies `v1` then `v2` in order on the first
 * deploy, reaching the identical end state. **Idempotent**, because a class already named by *any* tag is
 * not new — so a re-run allocates nothing and rewrites nothing, which is what `pithy add`'s contract and
 * `pithy upgrade`'s reconcile both depend on.
 */
export function appendDurableObjectMigrations(config: WranglerStanza, bindings: readonly BindingSpec[]): void {
  const classes = bindings
    .filter((binding) => binding.type === "durable_object" && binding.className !== undefined)
    .map((binding) => binding.className as string);
  if (classes.length === 0) return;

  config.migrations ??= [];
  // A class any existing tag already names is registered, whether or not that tag has been deployed yet.
  // This is the whole of the idempotency: a second `pithy add` of the same capability finds nothing new
  // and returns without touching the file. Any verb counts, not only the one the kit writes: an app's own
  // class reaches this writer too, and an adopter registered it by hand (#662).
  const registered = new Set(config.migrations.flatMap(classesRegisteredBy));
  const fresh = [...new Set(classes)].filter((className) => !registered.has(className));
  if (fresh.length === 0) return;

  config.migrations.push({ tag: nextMigrationTag(config.migrations), new_sqlite_classes: fresh });
}

/**
 * The next unused `v<n>` tag, counting past whatever is already there.
 *
 * Counting rather than incrementing the last one, because a tag an adopter wrote by hand need not be
 * `v<n>` at all, and a collision would silently merge this step into theirs — the exact failure the split
 * exists to prevent. The loop terminates: each pass tries a strictly larger number against a finite set.
 */
function nextMigrationTag(migrations: readonly DurableObjectMigration[]): string {
  const taken = new Set(migrations.map((migration) => migration.tag));
  let n = migrations.length + 1;
  while (taken.has(`${DO_MIGRATION_TAG_PREFIX}${n}`)) n += 1;
  return `${DO_MIGRATION_TAG_PREFIX}${n}`;
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
