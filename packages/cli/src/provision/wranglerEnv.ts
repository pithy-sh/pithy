// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { ProvisionScope, ProvisionWorkerNames } from "@pithy-sh/core/src/naming/provisionScope";
import { BASE_URL_VAR, SELF_BINDING } from "@pithy-sh/core/src/worker/identity";
import { parse } from "comment-json";
import type { HostedWorkflowEntry } from "../feature/hosts";
import type { FeatureResource } from "../feature/manifest";
import { featureNamespaceId } from "../feature/ratelimits";
import { type AppOwnedWorkflow, applyAppWorkflows, planAppWorkflows } from "../project/appWorkflows";
import { appendBinding, bindingSlot, placeBinding, type WranglerStanza } from "../project/bindingEntries";
import { declaredBindingSpecs } from "../project/declaredBindings";
import { writeJsonc } from "../project/jsonc";
import { readOptionalFile } from "../project/readOptionalFile";
import { inheritAddressKeys, resolveWorkerAddress } from "../project/workerAddress";
import { readWranglerConfig } from "../project/wrangler";
import { CARRIED_INTO_FEATURE, stanzaFor } from "../project/wranglerInheritance";
import { absolutizePaths, featureConfigPath, provisionConfigPath } from "./featureConfig";
import type { SecretStoreBinding } from "./secretBindings";

/**
 * After provisioning stands up an environment's D1, KV, R2 and queue resources, their ids land in each
 * Worker's `wrangler.jsonc` under `env.<name>`, where the remote `migrate` and `seed` drivers and
 * `wrangler deploy --env <name>` read them. Upserted by binding name, every comment in the JSONC kept.
 *
 * **One writer, taking the scope.** The stanza key is `scope.stanza` and every name is the same scope's, so
 * the file written and the names written in it come from one decision.
 */

/** One binding-id entry keyed by binding, plus the id field that resource kind uses in wrangler.jsonc. */
interface BindingEntry {
  binding: string;
  [field: string]: string;
}

/** One `services` entry: the binding name and the Worker script it resolves to in this environment. */
export interface ServiceEntry {
  /** The binding name in the Worker env (e.g. `BOARD`). */
  binding: string;
  /** The script name that binding reaches in this scope. */
  service: string;
}

/**
 * **This scope's script name for a Worker of this project, or `undefined` when the name is not one of them.**
 *
 * The resolution `services` goes through — `resolveServiceTarget` then `scope.worker(...)`, in
 * `provision/environment.ts` — handed here so a `durable_objects` entry pointing at a sibling Worker reaches that
 * sibling's copy in this scope. It answers `undefined` rather than throwing: a DO `script_name` may name a Worker
 * this project does not own.
 */
export type ScopedScript = (target: string) => string | undefined;

/** One `durable_objects.bindings` entry: the namespace binding, its class, and the script holding it. */
interface DurableObjectEntry {
  /** The binding name the Worker env exposes, e.g. `ROOM`. */
  name: string;
  /** The exported `DurableObject` subclass. */
  class_name: string;
  /** The Worker the class lives in. **Absent is same-script** — this Worker's own `main`. */
  script_name?: string;
}

/** The env stanza slice provisioning writes: the Worker's own name, its binding arrays, and its services. */
interface EnvBindings {
  name?: string;
  vars?: Record<string, unknown>;
  route?: string | { pattern?: string };
  routes?: (string | { pattern?: string })[];
  workers_dev?: unknown;
  d1_databases?: BindingEntry[];
  kv_namespaces?: BindingEntry[];
  r2_buckets?: BindingEntry[];
  services?: ServiceEntry[];
  secrets_store_secrets?: SecretStoreBinding[];
  /**
   * Both shapes: a kit host's cross-script entry ({@link HostedWorkflowEntry}) and the app's own same-script
   * one ({@link AppOwnedWorkflow}), which is how `appWorkflows.ts` tells them apart.
   */
  workflows?: (AppOwnedWorkflow & { script_name?: string })[];
  durable_objects?: { bindings?: DurableObjectEntry[] };
  /** One Email Sending binding: its name in the env, and whatever the adopter says about where mail may go. */
  send_email?: { name: string; [field: string]: unknown }[];
  /** A queue binding's producer entries — the queue this scope created for each — and any consumers. */
  queues?: { producers?: BindingEntry[]; consumers?: unknown[] };
  /** The Artifacts bindings, each naming this scope's namespace of repositories. */
  artifacts?: { binding: string; namespace?: string; [field: string]: unknown }[];
  triggers?: { crons?: string[] };
}

/**
 * Upsert the `secrets_store_secrets` entries provisioning owns into a stanza already being edited, by
 * binding — an adopter's hand-added entry is left where it is. A mutation rather than an edit of its own,
 * so the writer that owns the rest of the stanza does it in the same edit.
 */
function upsertSecretBindings(stanza: EnvBindings, entries: readonly SecretStoreBinding[]): void {
  const secrets = bindingSlot(stanza, "secrets_store_secrets", []);
  for (const entry of entries) {
    const existing = secrets.find((candidate) => candidate.binding === entry.binding);
    if (existing) Object.assign(existing, entry);
    else secrets.push({ ...entry });
  }
}

/**
 * The wrangler array and the fields provisioning owns for each resource kind. The entry itself is created by
 * {@link appendBinding}, the writer `pithy add`, `pithy upgrade` and `pithy worker sync` use; these are the
 * fields stamped onto it once the resource exists.
 *
 * **D1 carries its name as well as its id.** `pithy add` proposes a `database_name` offline, and provisioning
 * makes the proposal true: a stanza with only the id would assert one name while addressing a database that may
 * carry another.
 *
 * **A queue's array is `queues.producers`, one level down.** A producer names its queue by name, not by id, so
 * the name this scope created it under is what is written; the consumers beside it are left alone.
 */
const KIND_TO_WRANGLER: Record<
  FeatureResource["kind"],
  { array: (stanza: EnvBindings) => BindingEntry[] | undefined; fields: (r: FeatureResource) => Record<string, string> }
> = {
  d1: { array: (stanza) => stanza.d1_databases, fields: (r) => ({ database_name: r.name, database_id: r.id }) },
  kv: { array: (stanza) => stanza.kv_namespaces, fields: (r) => ({ id: r.id }) },
  r2: { array: (stanza) => stanza.r2_buckets, fields: (r) => ({ bucket_name: r.id }) },
  queue: { array: (stanza) => stanza.queues?.producers, fields: (r) => ({ queue: r.name }) },
};

/**
 * Stamp the fields provisioning owns onto a resource's entry, in place so comment-json keeps the array's
 * comments. Nothing is written when the stanza has no entry for the binding yet.
 *
 * A producer moved onto this scope's queue takes the consumer of the queue it left with it, settings and all,
 * so the Worker never sends to one queue while reading another environment's. A stanza that already consumes
 * this scope's queue keeps that consumer, and the other is left alone.
 */
function stampProvisioned(stanza: EnvBindings, resource: FeatureResource): void {
  const { array, fields } = KIND_TO_WRANGLER[resource.kind];
  const entry = array(stanza)?.find((candidate) => candidate.binding === resource.binding);
  if (entry === undefined) return;
  if (resource.kind === "queue" && entry.queue !== undefined && entry.queue !== resource.name) {
    const consumers = (stanza.queues?.consumers ?? []) as { queue?: unknown }[];
    const left = consumers.find((consumer) => consumer.queue === entry.queue);
    if (left !== undefined && !consumers.some((consumer) => consumer.queue === resource.name)) {
      left.queue = resource.name;
    }
  }
  Object.assign(entry, fields(resource));
}

/**
 * Write one Worker's whole `env.<scope.stanza>` stanza: the resource ids it declares, the script name it
 * deploys under in this scope, and each of its `service` bindings retargeted at this scope's copy of the
 * callee.
 *
 * The stanza is created when absent and reused when present, so this is also what makes provisioning the
 * creator of a stanza for an environment declared after the project was scaffolded — and creating one is
 * why it goes through `stanzaFor` rather than `config.env[key] ??= {}`: an `env.<name>` stanza inherits
 * none of `vars`, `version_metadata` or their forty-odd siblings from the top level, so a stanza that
 * holds nothing but ids deploys without every one of them. Idempotent, and every comment in the file
 * survives the round trip.
 */
async function editStanza(
  workerDir: string,
  stanzaKey: string,
  /**
   * **`source` decides the file, not the caller.** A declared environment's ids are read in a pull
   * request, so they go into the tracked `wrangler.jsonc`. A feature's are one job's output, so they go
   * into the generated config under the already-ignored `.wrangler/` — regenerated from the tracked
   * file every run, so it can never drift from it, and never making it dirty. That is what makes "a CI
   * run never commits back" a property of the code rather than a note in a runbook.
   */
  source: boolean,
  mutate: (stanza: EnvBindings, top: Record<string, unknown>) => void,
): Promise<string> {
  // Through the one reader, so a config that will not open is a refusal naming it, never node's own errno.
  const config = (await readWranglerConfig(workerDir)) as Record<string, unknown>;

  // A stanza this creates — and for `feature` it always creates one, since `env.feature` is unwritable in a
  // tracked config — starts with everything the top level declares that an environment does not inherit.
  const stanza = stanzaFor(config, stanzaKey) as EnvBindings;

  mutate(stanza, config);

  // One resolver for "which file?", shared with what the command reports.
  const destination = provisionConfigPath(workerDir, source);
  if (!source) {
    // Generated, so every path in it is rewritten against the directory it came from — wrangler
    // resolves a config's paths relative to the config, and this one lives two levels deeper.
    absolutizePaths(config, workerDir);
    await mkdir(dirname(destination), { recursive: true });
    await writeJsonc(destination, config);
    return destination;
  }

  // Through the one JSONC printer, never a raw `stringify`: `comment-json` puts every array element on its own
  // line, which the project's scaffolded Biome refuses, and `writeJsonc` keeps an adopter's hand-expanded
  // objects expanded so an edit in place stays a small diff.
  await writeJsonc(destination, config);
  return destination;
}

/**
 * Upsert the `secrets_store_secrets` entries provisioning owns into one Worker's `env.<stanza>`.
 *
 * Separate from {@link applyProvisionedEnv} because two commands reach it for different reasons.
 * `pithy provision` writes the whole stanza in either mode; `pithy secrets provision`
 * writes only this, for a project whose resources are already in place and whose store entries have
 * just been created.
 *
 * **Only the entries it owns.** An adopter's hand-added binding this registry does not declare is left
 * exactly where it is.
 */
export async function applySecretBindings(
  workerDir: string,
  stanzaKey: string,
  entries: readonly SecretStoreBinding[],
): Promise<void> {
  if (entries.length === 0) return;
  // Always the tracked file: only `pithy secrets provision` calls this directly, and it acts on the
  // environments a project deploys to. A feature's stanza is written by the scope-driven writer below.
  await editStanza(workerDir, stanzaKey, true, (stanza) => upsertSecretBindings(stanza, entries));
}

/**
 * **A feature's stanza states no route.** `routes: []`, written, because wrangler inherits a top-level
 * `routes` (or `route`) into every environment that does not set its own. Inherited, a branch deploy would take
 * the project's custom domain — whatever production or `dev` routes to — and with routes and no `workers_dev`,
 * wrangler gives it no `workers.dev` address at all, so the address stamped for it would answer nothing. An empty
 * list is the stanza's own and wins over the top level's, and with no routes wrangler's default is `workers.dev`
 * on. A top-level `workers_dev: false` is still honored: the adopter said no `workers.dev`, so the feature gets no
 * address rather than one nothing serves.
 *
 * Stripped rather than refused: a feature's only address is the one composed from its branch, so a route is
 * never something a feature stanza should carry, and a project with a top-level route must still be able to
 * provision a branch.
 */
function stripFeatureRoutes(stanza: EnvBindings, top: Record<string, unknown>): string[] {
  // What wrangler would have deployed the feature on, said back to the operator before it goes: a route declared
  // on purpose under a tracked `env.feature` must not vanish without a word. The stanza's own when it has one,
  // else the top level's it would inherit.
  const own = stanza.route !== undefined || stanza.routes !== undefined;
  const dropped = routePatterns(own ? stanza : (top as EnvBindings));
  delete stanza.route;
  stanza.routes = [];
  return dropped;
}

/** The patterns a stanza routes, in the two shapes wrangler takes: `route` and `routes`, strings or objects. */
function routePatterns(stanza: EnvBindings): string[] {
  const entries = [...(stanza.route !== undefined ? [stanza.route] : []), ...(stanza.routes ?? [])];
  return entries.flatMap((entry) => {
    const pattern = typeof entry === "string" ? entry : entry?.pattern;
    return typeof pattern === "string" && pattern !== "" ? [pattern] : [];
  });
}

/** One `ratelimits` entry, as far as this reads one: its binding name, its namespace, and whatever else. */
interface RatelimitEntry {
  name?: string;
  [field: string]: unknown;
}

/** The name an entry of a carried array binds under: `binding`, or `name` where wrangler spells it so. */
function entryName(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  return record.binding ?? record.name;
}

/**
 * **A feature binds every carried entry the top level declares, a tracked `env.feature` included.**
 *
 * `stanzaFor` carries every `carry` and `branch` kind's entries into a stanza it creates. A tracked `env.feature`
 * is not one it creates — it is the adopter's, handed back untouched — so an entry added to the top level after it
 * was written would reach no feature. Every key in {@link CARRIED_INTO_FEATURE} is refilled here, by binding name,
 * and an entry the stanza already binds is the adopter's and is kept.
 *
 * **One function, the policy's rather than a kind's.** A key is in the list because its kind's `seedPolicy` says
 * a feature inherits it; nothing here knows what any one of them is.
 *
 * Object-shaped kinds (`ai`, `browser`, `images`) are one binding per Worker, so the stanza's own is kept whole and
 * the top level's is copied only where the stanza has none.
 */
function featureCarried(stanza: Record<string, unknown>, top: Record<string, unknown>): void {
  for (const key of CARRIED_INTO_FEATURE) {
    const declared = top[key];
    if (declared === undefined) continue;
    if (!Array.isArray(declared)) {
      if (stanza[key] === undefined) placeBinding(stanza, key, structuredClone(declared));
      continue;
    }
    const own = Array.isArray(stanza[key]) ? (stanza[key] as unknown[]) : undefined;
    const bound = new Set((own ?? []).map(entryName));
    const missing = declared.filter((entry) => !bound.has(entryName(entry))).map((entry) => structuredClone(entry));
    if (missing.length === 0) continue;
    // In place when the array is there, so comment-json keeps the adopter's comments on it.
    if (own) own.push(...missing);
    else placeBinding(stanza, key, missing);
  }
}

/**
 * **A feature's rate limiters each take a namespace of their own.**
 *
 * {@link featureCarried} has already given the stanza every limiter the top level declares. **Every entry is then
 * given the feature namespace for its limiter**, the copied ones and any declared under a tracked `env.feature`
 * alike: `featureNamespaceId`, the declared namespace offset into the range reserved for
 * features, which no staging or production config may declare (`feature/ratelimits.ts`). Every feature binds the
 * same id for the same limiter; a limiter two Workers share in production is one here, and two are two. A limiter
 * that cannot map is refused rather than keep an id another environment holds.
 */
function featureRatelimits(stanza: Record<string, unknown>): void {
  const entries = Array.isArray(stanza.ratelimits) ? (stanza.ratelimits as RatelimitEntry[]) : [];
  for (const entry of entries) entry.namespace_id = featureNamespaceId(entry);
}

/**
 * **Retarget one entry's `script_name` at this scope's copy of the Worker it names, or say it has to go.**
 *
 * The one rule both `durable_objects` and hand-written `services` answer to, because they are one piece of
 * wiring said twice: each names a *script*, and in a feature the script a sibling Worker deploys
 * under is that sibling's feature copy.
 *
 * **A name no Worker of this project deploys under is stripped, never written.** It reaches a live Worker
 * somebody else owns, and a feature that bound it would read and write a stranger's Durable Object namespace or
 * dispatch into their Worker — worse than the absent binding, which fails loudly on the first request.
 * `stripFeatureRoutes` twenty lines up makes the same trade for the same reason, and `seedValue`'s docstring
 * states the preference: an absent binding fails loudly, a shared one corrupts quietly.
 */
function retargetScript(what: string, script: string, scopedScript: ScopedScript, dropped: string[]): string | null {
  const scoped = scopedScript(script);
  if (scoped !== undefined) return scoped;
  dropped.push(`${what}: ${script}`);
  return null;
}

/**
 * **A feature binds every Durable Object namespace the top level declares, each in this feature's copy of the
 * Worker that hosts it.**
 *
 * `durable_objects` is one of the keys an environment does not inherit and `stanzaFor` empties the lists in a
 * stanza it seeds, so this puts a feature's back.
 *
 * **Three cases, and the third is nobody's to bind.**
 *
 * - **No `script_name`** — the class is in this Worker's own `main`. The entry is `{ name, class_name }`, names
 *   no Cloudflare resource, and is identical in dev, staging and a branch, so it is **copied**: there is nothing
 *   for a feature to rename.
 * - **A `script_name` naming one of this project's Workers** — a sibling, or this Worker itself. It is
 *   **retargeted** at this scope's copy of that Worker ({@link retargetScript}). A `script_name` names another
 *   *Worker*, not another environment, and the feature deploys its own copy of it.
 * - **A `script_name` naming a Worker outside this project** — **stripped**, and said out loud. See
 *   {@link retargetScript}.
 *
 * **Every entry is read, the top level's and the stanza's own.** A stanza an adopter wrote by hand still names
 * `dev`'s sibling script, and left there it binds the namespace the developers' dev Worker runs. The adopter's
 * *choice* — which binding, which class — is theirs and is never overwritten; the script it resolves to in this
 * environment is not a choice, it is this run's answer.
 */
function featureDurableObjects(
  stanza: EnvBindings,
  top: Record<string, unknown>,
  scopedScript: ScopedScript,
  dropped: string[],
): void {
  const declared = (top as EnvBindings).durable_objects?.bindings ?? [];
  const own = stanza.durable_objects?.bindings;
  const bound = new Set((own ?? []).map((entry) => entry.name));
  const missing = declared.filter((entry) => !bound.has(entry.name)).map((entry) => structuredClone(entry));
  // In place where the array is there, so comment-json keeps the adopter's comments on it.
  if (missing.length > 0) {
    if (own) own.push(...missing);
    else if (stanza.durable_objects) stanza.durable_objects.bindings = missing;
    else placeBinding(stanza, "durable_objects", { bindings: missing });
  }
  const entries = stanza.durable_objects?.bindings;
  if (!entries) return;
  const kept = entries.filter((entry) => {
    if (entry.script_name === undefined) return true;
    const scoped = retargetScript(`durable object ${entry.name}`, entry.script_name, scopedScript, dropped);
    if (scoped === null) return false;
    entry.script_name = scoped;
    return true;
  });
  entries.length = 0;
  entries.push(...kept);
}

/**
 * **A feature binds every `services` entry the top level declares, each at this scope's copy of the callee.**
 *
 * The same rule as the Durable Objects above, on purpose: one sibling Worker, reached by two keys, must be reached
 * by both or by neither. A capability's `service` binding is retargeted by the caller, out of the resolved Worker
 * set; a hand-written one is retargeted here, because the wiring is the adopter's declaration and a feature
 * deploys its own copy of every Worker in the project.
 *
 * An entry the stanza already declares is left alone here — the caller upserts the capability-declared ones over
 * the top of this — and one naming a script outside the project is stripped and reported, as above.
 */
function featureServices(
  stanza: EnvBindings,
  top: Record<string, unknown>,
  scopedScript: ScopedScript,
  dropped: string[],
  resolved: ReadonlySet<string>,
): void {
  const declared = (top as EnvBindings).services ?? [];
  const own = stanza.services;
  const bound = new Set((own ?? []).map((entry) => entry.binding));
  const missing = declared.filter((entry) => !bound.has(entry.binding)).map((entry) => structuredClone(entry));
  if (missing.length > 0) {
    if (own) own.push(...missing);
    else placeBinding(stanza, "services", missing);
  }
  const entries = stanza.services;
  if (!entries) return;
  const kept = entries.filter((entry) => {
    // A declared binding the caller resolved for this scope is written over the top of this one, kit Worker
    // targets included — so it is neither retargeted nor reported as a stranger's script.
    if (resolved.has(entry.binding)) return true;
    const scoped = retargetScript(`service ${entry.binding}`, entry.service, scopedScript, dropped);
    if (scoped === null) return false;
    entry.service = scoped;
    return true;
  });
  entries.length = 0;
  entries.push(...kept);
}

/**
 * **Every stanza binds every Artifacts entry the top level declares, each naming this scope's namespace.**
 *
 * `artifacts` is array-shaped and its kind's `seedPolicy` is `provision`, so `stanzaFor` empties it in a stanza it
 * creates: the top level's entry names `dev`'s namespace, and staging bound to it would put staging's repos beside a
 * developer's. This refills it, by binding, from the top level, and then names this scope's namespace on every
 * entry the stanza holds — the stanza's own included, because a namespace is not a choice an adopter makes per
 * environment, it is `<project>-<env>`, and the value is this run's answer rather than the file's. Cloudflare
 * creates the namespace on the first repo, so there is nothing to create first. The rest of each entry is kept.
 */
function scopedArtifacts(stanza: EnvBindings, top: Record<string, unknown>, namespace: () => string): void {
  const declared = (top as EnvBindings).artifacts ?? [];
  const own = stanza.artifacts;
  if (declared.length === 0 && own === undefined) return;
  const bound = new Set((own ?? []).map((entry) => entry.binding));
  const missing = declared.filter((entry) => !bound.has(entry.binding)).map((entry) => structuredClone(entry));
  // In place where the array is there, so comment-json keeps the adopter's comments on it.
  if (own) own.push(...missing);
  else placeBinding(stanza, "artifacts", missing);
  for (const entry of stanza.artifacts ?? []) entry.namespace = namespace();
}

/**
 * **A feature states its own cron schedule, empty included.**
 *
 * `triggers` is one of the keys wrangler *does* inherit, so a feature stanza that says nothing takes the top
 * level's crons — `dev`'s, or whatever an adopter runs in production. `setCrons` in `project/appWorkflows.ts`
 * deliberately writes nothing when a plan has none, and that is right for the file it writes: in a tracked
 * stanza an absent `crons` means "leave the deployed Worker's schedule alone", and inventing `[]` there would
 * clear a schedule nobody asked to clear.
 *
 * A feature has no deployed schedule to preserve. Its config is generated whole on every run, so the only thing
 * an absent `crons` can mean here is *inherit somebody else's*, and a branch would fire the project's production
 * schedule.
 *
 * **Only when nothing else has stated one.** The app's own declaration has already been written by
 * `applyAppWorkflows`, and a schedule an adopter wrote into a tracked `env.feature` is theirs and is kept.
 */
function featureCrons(stanza: EnvBindings): void {
  stanza.triggers ??= {};
  stanza.triggers.crons ??= [];
}

/**
 * Stamp a feature stanza's `vars.BASE_URL` with its derived `workers.dev` address, or remove the one it
 * inherited when there is none to derive.
 *
 * Derived from everything but `vars`: the stanza's own `BASE_URL` is what is being written, and the one it holds
 * now was copied from the top level, so reading it would be a feature adopting whatever the tracked file said.
 */
function stampFeatureAddress(stanza: EnvBindings, top: Record<string, unknown>, subdomain: string | null): void {
  const { vars: _inherited, ...address } = stanza;
  // As wrangler will deploy it: what the stanza says, and what it inherits from the top level.
  const resolved = resolveWorkerAddress({
    environment: FEATURE_ENVIRONMENT,
    stanza: inheritAddressKeys(top, address, FEATURE_ENVIRONMENT),
    subdomain,
  });
  if (resolved) {
    stanza.vars ??= {};
    stanza.vars[BASE_URL_VAR] = resolved.url;
    return;
  }
  if (stanza.vars) delete stanza.vars[BASE_URL_VAR];
}

/**
 * Write one Worker's stanza, and hand back **the path that was written** — the tracked `wrangler.jsonc`
 * or the generated artifact, as the scope decided. The caller reports it, so what a run says it wrote is
 * what the writer wrote rather than a second computation of the same rule.
 */
export async function applyProvisionedEnv(options: {
  /** The Worker's directory — the one holding the `wrangler.jsonc` to edit. */
  workerDir: string;
  /**
   * The Worker's two names — its `apps/<app>` directory and its deploy name — which `scope.worker` turns
   * into this scope's script name. Both, because a declared environment builds on the deploy name and a
   * feature on the directory; `provisionWorkerNames` in `./environment` is where they are read.
   */
  worker: ProvisionWorkerNames;
  /** The scope: both the stanza written into and the names written in. */
  scope: ProvisionScope;
  /** Only the resources this Worker's own config declares. */
  resources: readonly FeatureResource[];
  /** Only the service bindings this Worker's own config declares, already resolved to this scope. */
  services: readonly ServiceEntry[];
  /**
   * The `secrets_store_secrets` entries this Worker's own registry declares, named for this scope.
   *
   * `pithy add` cannot write these: the store entries do not exist until provisioning. It is complete by
   * construction — every entry carries its `store_id` and `secret_name` — because a
   * partial one does not degrade: wrangler refuses the whole config.
   */
  secrets: readonly SecretStoreBinding[];
  /**
   * Whether this project declares that it **administers itself** — the root `pithy.config.ts`'s
   * `administersItself`, read by the command and never inferred here.
   *
   * True writes one more `services` entry: {@link SELF_BINDING}, pointing at the script this very stanza
   * deploys as. A Worker cannot fetch its own hostname — the subrequest loops back through the edge into
   * the Worker it came from and hangs until Cloudflare answers 522 — so a deployment that calls its own
   * control plane dispatches through the runtime instead.
   *
   * **Written here, from `stanza.name`, rather than composed by the caller.** The binding has to name the
   * script the stanza deploys as, and this writer is where that string is decided. Composing it anywhere else
   * is a second producer of one address, and a binding pointing at a script nobody deploys provisions clean and
   * refuses at runtime. A feature's stanza is regenerated from the tracked file on every run, so it gets the
   * entry the same way.
   */
  administersItself: boolean;
  /**
   * The account's `workers.dev` subdomain, looked up by the caller — or `null` for an account with none, or
   * omitted when nobody asked. Read for a feature scope only, where it is how the stanza gets an address.
   *
   * **A feature's `vars.BASE_URL` is stamped from it.** A feature Worker answers on
   * `https://<script>.<subdomain>.workers.dev`, and the Worker cannot ask Cloudflare what the subdomain is. So
   * the address is derived here, through `resolveWorkerAddress`, from the `name` this same edit settles, and
   * written where `originFor` reads it inside the deployment. An account with no subdomain gets no address,
   * and the stanza loses any `BASE_URL` it inherited from the top level: that one is another environment's
   * origin, and a feature must never answer to it.
   */
  subdomain?: string | null;
  /**
   * **This Worker's own app capability — what its `workflows` table is derived from.**
   *
   * A feature's stanza is regenerated from the tracked file on every run and every binding array it seeds is
   * emptied, so the app's own Workflows are re-derived for it. The names come from {@link planAppWorkflows}
   * against `scope.workflowHost` — the derivation `pithy worker sync` writes staging's and prod's with, handed
   * the scope rather than an environment string.
   *
   * **Read for a feature scope only.** A declared environment's table lives in the tracked `wrangler.jsonc`,
   * written by `pithy worker sync` and reviewed in a pull request; provisioning writing it too would be a
   * second writer of one fact, and `project/workflows.ts` is the reader that already refuses a deploy whose
   * stanza disagrees with the declaration. Passing it for a declared environment changes nothing.
   *
   * Omitted for a Worker that declares no `app` in its `pithy.config.ts`, which writes no `workflows` key at
   * all — wrangler reads an empty one as a declaration.
   */
  app?: Capability;
  /**
   * This scope's script name for a Worker of this project — see {@link ScopedScript}. Read for a feature scope
   * only, where it is what retargets a `durable_objects` entry at this feature's copy of the Worker hosting the
   * class. Omitted, every such entry reads as another project's and is reported rather than retargeted.
   */
  scopedScript?: ScopedScript;
  /**
   * What this Worker composes. A resource's entry is written from the spec of the capability declaring its binding,
   * so it carries that spec's `consumer` and `remote` exactly as `pithy add` and `pithy worker sync` write them. A
   * resource no capability here declares is written from its kind and binding alone.
   */
  capabilities?: readonly Capability[];
  /**
   * Told the bindings a feature stanza gave up — a `durable_objects` or `services` entry naming a
   * script this project does not own. A feature has no copy of that Worker to point at, and binding a
   * stranger's live namespace is worse than binding nothing, so the entry is stripped and the run says so.
   */
  onBindingsDropped?: (bindings: string[]) => void;
  /**
   * Told the route patterns a feature stanza gave up — the ones it declared, or would have inherited. A
   * feature answers on its own `workers.dev` address only, so they are stripped, and the run says so.
   */
  onRoutesDropped?: (routes: string[]) => void;
}): Promise<string> {
  // **One edit, holding everything.** A feature's config is regenerated from the tracked file on every edit,
  // so a second edit would start from a stanza with no name, no ids and no services.
  return editStanza(options.workerDir, options.scope.stanza, options.scope.source, (stanza, top) => {
    // The scope decides, handed what the stanza already says. A declared environment reads a name it finds
    // and composes one only when there is none; a feature ignores it, because a feature's name is recomputed
    // on teardown.
    stanza.name = options.scope.worker(options.worker, stanza.name);
    // A feature's address, from the name just settled. Never a declared environment's: its address is
    // declared, and `workers.dev` can be disabled per account and commonly is in production.
    if (!options.scope.source) {
      const routes = stripFeatureRoutes(stanza, top);
      if (routes.length > 0) options.onRoutesDropped?.(routes);
      // Every carried kind first, so the limiters below are renumbered whichever stanza they came from.
      featureCarried(stanza as Record<string, unknown>, top);
      featureRatelimits(stanza as Record<string, unknown>);
      // One resolver and one list for both keys that name a sibling script, so a feature cannot bind the
      // Durable Object and drop the RPC to the same Worker.
      const scopedScript = options.scopedScript ?? (() => undefined);
      const dropped: string[] = [];
      featureDurableObjects(stanza, top, scopedScript, dropped);
      featureServices(stanza, top, scopedScript, dropped, new Set(options.services.map((entry) => entry.binding)));
      if (dropped.length > 0) options.onBindingsDropped?.(dropped);
      // The app's own Workflows, named for this scope — see `app` above for why only here, and
      // `project/appWorkflows.ts` for the one derivation both this and `pithy worker sync` write from.
      if (options.app) applyAppWorkflows(stanza, planAppWorkflows(options.app, options.scope.workflowHost));
      featureCrons(stanza);
      if (options.subdomain !== undefined) stampFeatureAddress(stanza, top, options.subdomain);
    }
    scopedArtifacts(stanza, top, () => options.scope.artifactsNamespace);
    const named = new Map(options.resources.map((resource) => [resource.binding, resource.name]));
    const declared = new Map(
      declaredBindingSpecs(options.capabilities ?? []).map((binding) => [binding.spec.name, binding]),
    );
    for (const resource of options.resources) {
      const binding = declared.get(resource.binding);
      // Stamped before the writer runs as well as after, so a consumer it adds is for this scope's queue.
      stampProvisioned(stanza, resource);
      appendBinding(
        stanza as WranglerStanza,
        binding?.spec ?? BindingSpec.parse({ type: resource.kind, name: resource.binding }),
        {
          env: options.scope.stanza,
          capability: binding?.capability.name ?? "provision",
          named,
        },
      );
      stampProvisioned(stanza, resource);
    }
    // The self binding last, so it is written from the `name` this edit has already settled and so the
    // kit's own constant wins over anything else that claimed it. Nothing is written for a project that
    // does not declare it: no `services` key, no empty array, no change to the stanza at all.
    const services = options.administersItself
      ? [...options.services, { binding: SELF_BINDING, service: stanza.name }]
      : options.services;
    if (services.length > 0) {
      const bound = bindingSlot(stanza, "services", []);
      for (const entry of services) {
        const existing = bound.find((candidate) => candidate.binding === entry.binding);
        if (existing) existing.service = entry.service;
        else bound.push({ ...entry });
      }
    }
    if (options.secrets.length > 0) upsertSecretBindings(stanza, options.secrets);
  });
}

/**
 * **Bind a feature's app Worker to the kit hosts that deployed, and to no other** — and
 * to the indexes the feature created for it.
 *
 * Written after the hosts' deploy rather than with the stanza, so a host that failed to deploy leaves no binding
 * to it: the next `pithy deploy --env feature` would otherwise ship an app Worker bound to a Workflow on a script
 * that does not exist. Every entry in `hosted` — each one this Worker declares into any kit host — is removed
 * first, and then the entries of the hosts that deployed are written back, so a re-run whose host now fails takes
 * the binding a previous run wrote with it. Each index is upserted by binding, as the feature's own.
 *
 * An edit of the **generated** config in place, not a regeneration from the tracked file: that is what the stanza
 * write above does, and a second regeneration would drop everything the first one wrote. Nothing is
 * written for a Worker whose generated config does not exist yet.
 */
export async function bindFeatureHosts(options: {
  /** The Worker's directory. Its generated feature config is the file edited. */
  workerDir: string;
  /** Every entry this Worker declares into a kit host, deployed or not — what is cleared. */
  hosted: readonly HostedWorkflowEntry[];
  /** The entries whose host deployed — what is written. A subset of {@link hosted}. */
  bound: readonly HostedWorkflowEntry[];
  /** The feature's own indexes this Worker binds, by binding. */
  indexes: readonly { binding: string; name: string }[];
}): Promise<void> {
  const path = featureConfigPath(options.workerDir);
  const raw = await readOptionalFile(path);
  if (raw === null) return;
  const config = parse(raw) as unknown as Record<string, unknown>;
  const stanza = stanzaFor(config, FEATURE_ENVIRONMENT) as EnvBindings & {
    vectorize?: { binding: string; index_name: string }[];
  };
  const cleared = new Set(options.hosted.map((entry) => entry.binding));
  const kept = (stanza.workflows ?? []).filter((entry) => !cleared.has(entry.binding));
  const next = [
    ...kept,
    ...options.bound.map(({ binding, name, class_name, script_name }) => ({ binding, name, class_name, script_name })),
  ];
  if (stanza.workflows) {
    // In place, so comment-json keeps the array's comments.
    stanza.workflows.length = 0;
    stanza.workflows.push(...next);
  } else if (next.length > 0) {
    placeBinding(stanza, "workflows", next);
  }
  for (const index of options.indexes) {
    const indexes = bindingSlot(stanza, "vectorize", []);
    const existing = indexes.find((entry) => entry.binding === index.binding);
    if (existing) existing.index_name = index.name;
    else indexes.push({ binding: index.binding, index_name: index.name });
  }
  await writeJsonc(path, config);
}
