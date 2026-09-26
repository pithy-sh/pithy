// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { ProvisionScope, ProvisionWorkerNames } from "@pithy-sh/core/src/naming/provisionScope";
import { BASE_URL_VAR, SELF_BINDING } from "@pithy-sh/core/src/worker/identity";
import { parse } from "comment-json";
import type { HostedWorkflowEntry } from "../feature/hosts";
import type { FeatureResource } from "../feature/manifest";
import { featureNamespaceId } from "../feature/ratelimits";
import { type AppOwnedWorkflow, applyAppWorkflows, planAppWorkflows } from "../project/appWorkflows";
import { writeJsonc } from "../project/jsonc";
import { readOptionalFile } from "../project/readOptionalFile";
import { inheritAddressKeys, resolveWorkerAddress } from "../project/workerAddress";
import { stanzaFor } from "../project/wranglerInheritance";
import { absolutizePaths, featureConfigPath, provisionConfigPath } from "./featureConfig";
import type { SecretStoreBinding } from "./secretBindings";

/**
 * After provisioning stands up an environment's D1/KV/R2 resources, their ids must land in each
 * Worker's `wrangler.jsonc` under `env.<name>` — that is exactly where the shared `migrate`/`seed`
 * remote drivers, and `wrangler deploy --env <name>`, read each binding's id from. This writes them
 * there, upserting by binding name and preserving every comment in the JSONC (a `pithy.config` output,
 * per CLAUDE.md).
 *
 * **One writer, taking the scope.** The stanza key is `scope.stanza` and every name is the same
 * scope's, so the file this writes into and the names it writes cannot come from two different
 * decisions — which is how a feature-named resource could once be written into a declared environment's
 * stanza.
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
 * The same resolution `services` already goes through — `resolveServiceTarget` then `scope.worker(...)`, in
 * `provision/environment.ts` — handed here as a function so a `durable_objects` entry pointing at a sibling
 * Worker reaches that sibling's copy in this scope rather than being dropped (#650 review). It answers
 * `undefined` rather than throwing, because unlike a `service` target — which an adopter writes as an
 * `apps/<name>` and must exist — a DO `script_name` may legitimately name a Worker this project does not own.
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
   * one ({@link AppOwnedWorkflow}), which is exactly how `appWorkflows.ts` tells them apart (#650).
   */
  workflows?: (AppOwnedWorkflow & { script_name?: string })[];
  durable_objects?: { bindings?: DurableObjectEntry[] };
  /** One Email Sending binding: its name in the env, and whatever the adopter says about where mail may go. */
  send_email?: { name: string; [field: string]: unknown }[];
  triggers?: { crons?: string[] };
}

/**
 * Upsert a binding's fields into a binding array **in place**, so comment-json's array-internal
 * comments (stored as symbol-keyed properties on the array object) survive — a `filter()` would return
 * a plain array and silently drop them. A matching binding's fields are updated on the existing entry;
 * otherwise the entry is pushed.
 */
function upsertByBinding(entries: BindingEntry[], binding: string, fields: Record<string, string>): void {
  const existing = entries.find((entry) => entry.binding === binding);
  if (existing) Object.assign(existing, fields);
  else entries.push({ binding, ...fields });
}

/**
 * Upsert the `secrets_store_secrets` entries provisioning owns into a stanza already being edited, by
 * binding — an adopter's hand-added entry is left where it is. A mutation rather than an edit of its own,
 * so the writer that owns the rest of the stanza does it in the same edit (#592).
 */
function upsertSecretBindings(stanza: EnvBindings, entries: readonly SecretStoreBinding[]): void {
  stanza.secrets_store_secrets ??= [];
  for (const entry of entries) {
    const existing = stanza.secrets_store_secrets.find((candidate) => candidate.binding === entry.binding);
    if (existing) Object.assign(existing, entry);
    else stanza.secrets_store_secrets.push({ ...entry });
  }
}

/** The `EnvBindings` keys holding a binding array — the only ones an id is upserted into. */
type BindingArrayKey = "d1_databases" | "kv_namespaces" | "r2_buckets";

/**
 * The wrangler key and the fields provisioning owns for each resource kind.
 *
 * **D1 carries its name as well as its id**, and that is not decoration: `pithy add` proposes a
 * `database_name` offline, before any account has been reached, and provisioning is the step that makes
 * the proposal true. Writing only the id would leave a stanza asserting one name while addressing a
 * database that may carry another — the two must be written by the same step or they drift.
 */
const KIND_TO_WRANGLER: Record<
  FeatureResource["kind"],
  { array: BindingArrayKey; fields: (r: FeatureResource) => Record<string, string> }
> = {
  d1: { array: "d1_databases", fields: (r) => ({ database_name: r.name, database_id: r.id }) },
  kv: { array: "kv_namespaces", fields: (r) => ({ id: r.id }) },
  r2: { array: "r2_buckets", fields: (r) => ({ bucket_name: r.id }) },
};

/**
 * Write one Worker's whole `env.<scope.stanza>` stanza: the resource ids it declares, the script name it
 * deploys under in this scope, and each of its `service` bindings retargeted at this scope's copy of the
 * callee.
 *
 * The stanza is created when absent and reused when present, so this is also what makes provisioning the
 * creator of a stanza for an environment declared after the project was scaffolded — and creating one is
 * why it goes through `stanzaFor` rather than `config.env[key] ??= {}`: an `env.<name>` stanza inherits
 * none of `vars`, `version_metadata` or their forty-odd siblings from the top level, so a stanza that
 * holds nothing but ids deploys without every one of them (#581). Idempotent, and every comment in the
 * file survives the round trip.
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
  const raw = await readFile(join(workerDir, "wrangler.jsonc"), "utf8");
  const config = parse(raw) as unknown as Record<string, unknown>;

  // Through the one stanza reader (#581), never `config.env[key] ??= {}`. A stanza this creates — and for
  // `feature` it always creates one, since `env.feature` is unwritable in a tracked config — starts with
  // everything the top level declares that an environment does not inherit. Filling in ids on an otherwise
  // empty stanza is what shipped every feature deploy with no `vars` at all.
  const stanza = stanzaFor(config, stanzaKey) as EnvBindings;

  mutate(stanza, config);

  // One resolver for "which file?", shared with what the command reports (#251). A run states where it
  // wrote and whether that file is committed; a report computing the path a second time is a sentence
  // that can disagree with the write it describes.
  const destination = provisionConfigPath(workerDir, source);
  if (!source) {
    // Generated, so every path in it is rewritten against the directory it came from — wrangler
    // resolves a config's paths relative to the config, and this one lives two levels deeper.
    absolutizePaths(config, workerDir);
    await mkdir(dirname(destination), { recursive: true });
    await writeJsonc(destination, config);
    return destination;
  }

  // Through the one JSONC printer (#249), never a raw `stringify`. `comment-json` puts every array
  // element on its own line; the project's own scaffolded Biome collapses a short one — so a config
  // written the other way fails the pre-commit hook this CLI installed. `writeJsonc` also keeps an
  // adopter's hand-expanded objects expanded, which matters most here: this file is edited in place on
  // every provision, and a two-line change buried in a whole-file reformat is a change nobody reviewed.
  await writeJsonc(destination, config);
  return destination;
}

/**
 * Upsert the `secrets_store_secrets` entries provisioning owns into one Worker's `env.<stanza>`.
 *
 * Separate from {@link applyProvisionedEnv} because two commands reach it for different reasons.
 * `pithy provision` writes the whole stanza in either mode; `pithy secrets provision`
 * writes only this, for a project whose resources are already in place and whose store entries have
 * just been created — the five cases `ensureSecretsStoreId` cannot resolve at `add` time, and every
 * project that predates the stanza existing at all.
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
 * **A feature's stanza states no route (#643).** `routes: []`, written, because wrangler inherits a top-level
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
  // What wrangler would have deployed the feature on, said back to the operator before it goes (F4 of #643's
  // review): a route declared on purpose under a tracked `env.feature` must not vanish without a word. The
  // stanza's own when it has one, else the top level's it would inherit.
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

/**
 * **A feature binds every rate limiter the top level declares, each in a namespace of its own (#643).**
 *
 * Wrangler does not inherit `ratelimits` into an environment, and `stanzaFor` copies them only into a stanza it
 * creates — so a tracked `env.feature` without them deployed a Worker with no `AUTH_RATE_LIMITER`, and auth
 * refused every request. Each top-level entry the stanza does not already bind by name is copied.
 *
 * **And every entry is then given the feature namespace for its limiter**, the copied ones and any declared under
 * a tracked `env.feature` alike: `featureNamespaceId`, the declared namespace offset into the range reserved for
 * features, which no staging or production config may declare (`feature/ratelimits.ts`). Every feature binds the
 * same id for the same limiter; a limiter two Workers share in production is one here, and two are two. A limiter
 * that cannot map is refused rather than keep an id another environment holds.
 */
function featureRatelimits(stanza: Record<string, unknown>, top: Record<string, unknown>): void {
  const declared = Array.isArray(top.ratelimits) ? (top.ratelimits as RatelimitEntry[]) : [];
  const own = Array.isArray(stanza.ratelimits) ? (stanza.ratelimits as RatelimitEntry[]) : [];
  const bound = new Set(own.map((entry) => entry.name));
  const missing = declared.filter((entry) => typeof entry.name === "string" && !bound.has(entry.name));
  // In place when the array is there, so comment-json keeps the adopter's comments on it.
  if (missing.length > 0) {
    if (Array.isArray(stanza.ratelimits)) own.push(...missing.map((entry) => structuredClone(entry)));
    else stanza.ratelimits = missing.map((entry) => structuredClone(entry));
  }
  const entries = Array.isArray(stanza.ratelimits) ? (stanza.ratelimits as RatelimitEntry[]) : [];
  for (const entry of entries) entry.namespace_id = featureNamespaceId(entry);
}

/**
 * **Retarget one entry's `script_name` at this scope's copy of the Worker it names, or say it has to go.**
 *
 * The one rule both `durable_objects` and hand-written `services` answer to, because they are one piece of
 * wiring said twice (#650 review): each names a *script*, and in a feature the script a sibling Worker deploys
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
 * Worker that hosts it (#650).**
 *
 * The second kind the feature stanza lost, and it is lost the same way the Workflows were: `durable_objects` is
 * one of the keys an environment does not inherit, `stanzaFor` empties the lists in a stanza it seeds, and
 * nothing puts a feature's back. A Worker composing `multiplayer` therefore deployed with no `ROOM` and answered
 * `Missing required bindings: durable_object:ROOM` on every request.
 *
 * **Three cases, and the third is nobody's to bind.**
 *
 * - **No `script_name`** — the class is in this Worker's own `main`. The entry is `{ name, class_name }`, names
 *   no Cloudflare resource, and is identical in dev, staging and a branch, so it is **copied**: there is nothing
 *   for a feature to rename. That is the whole difference from the Workflows beside it, which are derived.
 * - **A `script_name` naming one of this project's Workers** — a sibling, or this Worker itself. It is
 *   **retargeted** at this scope's copy of that Worker ({@link retargetScript}). A `script_name` names another
 *   *Worker*, not another environment, and the feature deploys its own copy of it.
 * - **A `script_name` naming a Worker outside this project** — **stripped**, and said out loud. See
 *   {@link retargetScript}.
 *
 * **Every entry is read, the top level's and the stanza's own (#650 review).** `featureRatelimits` rewrites a
 * tracked `env.feature`'s entries for exactly this reason: a stanza an adopter wrote by hand still names `dev`'s
 * sibling script, and leaving it there was a feature binding the namespace its own developers' dev Worker runs.
 * The adopter's *choice* — which binding, which class — is theirs and is never overwritten; the script it
 * resolves to in this environment is not a choice, it is this run's answer.
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
    else stanza.durable_objects = { bindings: missing };
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
 * **A feature binds every `services` entry the top level declares, each at this scope's copy of the callee
 * (#650 review).**
 *
 * The same rule as the Durable Objects above, and it is the same rule on purpose: one sibling Worker, reached by
 * two keys, must be reached by both or by neither. A capability's `service` binding was already retargeted — by
 * the caller, out of the resolved Worker set — and a *hand-written* one was emptied with the rest of the stanza
 * and never put back, so an adopter who wired two of their own Workers together got the Durable Object and not
 * the RPC. **Retarget both** rather than drop both: the wiring is the adopter's declaration, a feature deploys
 * its own copy of every Worker in the project, and the binding is meaningful there.
 *
 * An entry the stanza already declares is left alone here — the caller upserts the capability-declared ones over
 * the top of this — and one naming a script outside the project is stripped and reported, as above.
 */
function featureServices(
  stanza: EnvBindings,
  top: Record<string, unknown>,
  scopedScript: ScopedScript,
  dropped: string[],
): void {
  const declared = (top as EnvBindings).services ?? [];
  const own = stanza.services;
  const bound = new Set((own ?? []).map((entry) => entry.binding));
  const missing = declared.filter((entry) => !bound.has(entry.binding)).map((entry) => structuredClone(entry));
  if (missing.length > 0) {
    if (own) own.push(...missing);
    else stanza.services = missing;
  }
  const entries = stanza.services;
  if (!entries) return;
  const kept = entries.filter((entry) => {
    const scoped = retargetScript(`service ${entry.binding}`, entry.service, scopedScript, dropped);
    if (scoped === null) return false;
    entry.service = scoped;
    return true;
  });
  entries.length = 0;
  entries.push(...kept);
}

/**
 * **A feature binds every Email Sending destination the top level declares (#650 review).**
 *
 * A `send_email` entry is `{ name, destination_address? | allowed_destination_addresses? }`: a binding name and
 * an address verified once at the Cloudflare account. Nothing in it is a resource an environment owns, and
 * `email` is in neither `isWrittenBinding` nor `isProvisionedBinding`, so an emptied one is refilled by nothing
 * anywhere — a hand-written `NOTIFY` came back as `env.NOTIFY is undefined` at the first send.
 *
 * **Refilled here rather than through `CARRIED_WHOLE`, and the difference is which environments it reaches.**
 * A feature seeds from the top level by design — that is what a branch of `dev` is — so carrying dev's
 * destination into it is the same decision `vars` already makes. A **declared** environment is not: seeding
 * `env.prod` from the top level would write dev's routing into production's first stanza, where the adopter's
 * next deploy mails real users at the address their laptop uses. A declared environment's stanza is created
 * with an empty list instead — `seedValue`'s "this environment has none", which they fill in with the address
 * that environment should send from.
 */
function featureSendEmail(stanza: EnvBindings, top: Record<string, unknown>): void {
  const declared = (top as EnvBindings).send_email ?? [];
  if (declared.length === 0) return;
  const own = stanza.send_email;
  const bound = new Set((own ?? []).map((entry) => entry.name));
  const missing = declared.filter((entry) => !bound.has(entry.name)).map((entry) => structuredClone(entry));
  if (missing.length === 0) return;
  if (own) own.push(...missing);
  else stanza.send_email = missing;
}

/**
 * **A feature states its own cron schedule, empty included (#650 review).**
 *
 * `triggers` is one of the keys wrangler *does* inherit, so a feature stanza that says nothing takes the top
 * level's crons — `dev`'s, or whatever an adopter runs in production. `setCrons` in `project/appWorkflows.ts`
 * deliberately writes nothing when a plan has none, and that is right for the file it writes: in a tracked
 * stanza an absent `crons` means "leave the deployed Worker's schedule alone", and inventing `[]` there would
 * clear a schedule nobody asked to clear.
 *
 * A feature has no deployed schedule to preserve. Its config is generated whole on every run, so the only thing
 * an absent `crons` can mean here is *inherit somebody else's* — which is how a branch came to fire the
 * project's production schedule.
 *
 * **Only when nothing else has stated one.** This fills a gap; it does not settle the question. The app's own
 * declaration has already been written by `applyAppWorkflows`, and a schedule an adopter wrote into a tracked
 * `env.feature` is theirs — the rule this module states everywhere else, and one this used to break by writing
 * an empty list over a cron they deliberately wrote there.
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
 * what the writer wrote rather than a second computation of the same rule (#251).
 */
export async function applyProvisionedEnv(options: {
  /** The Worker's directory — the one holding the `wrangler.jsonc` to edit. */
  workerDir: string;
  /**
   * The Worker's two names — its `apps/<app>` directory and its deploy name — which `scope.worker` turns
   * into this scope's script name. Both, because a declared environment builds on the deploy name and a
   * feature on the directory (#587); `provisionWorkerNames` in `./environment` is where they are read.
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
   * This is the stanza `pithy add` deliberately could not write and nothing came back for (#238, #239).
   * It is complete by construction — every entry carries its `store_id` and `secret_name` — because a
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
   * script the stanza deploys as, and this writer is where that string is decided (one line up). Composing
   * it anywhere else is a second producer of one address, which is the shape #580 and #587 both closed —
   * and the shape that fails silently, because a binding pointing at a script nobody deploys provisions
   * clean and refuses at runtime. A feature environment is covered by construction: its stanza is
   * regenerated from the tracked file on every run, so a hand-written entry could never have survived one.
   */
  administersItself: boolean;
  /**
   * The account's `workers.dev` subdomain, looked up by the caller — or `null` for an account with none, or
   * omitted when nobody asked. Read for a feature scope only, where it is how the stanza gets an address.
   *
   * **A feature's `vars.BASE_URL` is stamped from it (#643).** A feature Worker answers on
   * `https://<script>.<subdomain>.workers.dev`, and the Worker cannot ask Cloudflare what the subdomain is. So
   * the address is derived here, through `resolveWorkerAddress`, from the `name` this same edit settles, and
   * written where `originFor` reads it inside the deployment. An account with no subdomain gets no address,
   * and the stanza loses any `BASE_URL` it inherited from the top level: that one is another environment's
   * origin, and a feature must never answer to it.
   */
  subdomain?: string | null;
  /**
   * **This Worker's own app capability — what its `workflows` table is derived from (#650).**
   *
   * A feature's stanza is regenerated from the tracked file on every run and every binding array it seeds is
   * emptied, so the app's own Workflows had to be re-derived for it or the Worker deployed with none: the
   * feature answered `Missing required bindings: workflow:CONNECTION_ROTATION, workflow:ROTATION_SWEEP` on
   * every request, `/health` included. The names come from {@link planAppWorkflows} against
   * `scope.workflowHost` — the same derivation `pithy worker sync` writes staging's and prod's with, handed
   * the scope rather than an environment string, so a feature's table and a declared environment's cannot
   * come to mean different things by "the app's own".
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
   * Told the bindings a feature stanza gave up (#650 review) — a `durable_objects` or `services` entry naming a
   * script this project does not own. A feature has no copy of that Worker to point at, and binding a
   * stranger's live namespace is worse than binding nothing, so the entry is stripped and the run says so.
   */
  onBindingsDropped?: (bindings: string[]) => void;
  /**
   * Told the route patterns a feature stanza gave up (#643) — the ones it declared, or would have inherited. A
   * feature answers on its own `workers.dev` address only, so they are stripped, and the run says so.
   */
  onRoutesDropped?: (routes: string[]) => void;
}): Promise<string> {
  // **One edit, holding everything (#592).** A feature's config is regenerated from the tracked file on
  // every edit, so this was two edits for as long as the secrets were a second one: the second started
  // from a stanza with no name, no ids and no services, and kept only the secrets. The Worker deployed
  // as wrangler's `<script>-feature` — a script nothing records and teardown never deletes.
  return editStanza(options.workerDir, options.scope.stanza, options.scope.source, (stanza, top) => {
    // The scope decides, and it is handed what the stanza already says (#580). A declared environment
    // reads a name it finds and composes one only when there is none; a feature ignores it, because a
    // feature's name is recomputed on teardown. Deciding here instead would put that asymmetry in a
    // writer, which is how one used to get it wrong.
    stanza.name = options.scope.worker(options.worker, stanza.name);
    // A feature's address, from the name just settled. Never a declared environment's: its address is
    // declared, and `workers.dev` can be disabled per account and commonly is in production (#89).
    if (!options.scope.source) {
      const routes = stripFeatureRoutes(stanza, top);
      if (routes.length > 0) options.onRoutesDropped?.(routes);
      featureRatelimits(stanza as Record<string, unknown>, top);
      // One resolver and one list for both keys that name a sibling script, so a feature cannot bind the
      // Durable Object and drop the RPC to the same Worker (#650 review).
      const scopedScript = options.scopedScript ?? (() => undefined);
      const dropped: string[] = [];
      featureDurableObjects(stanza, top, scopedScript, dropped);
      featureServices(stanza, top, scopedScript, dropped);
      featureSendEmail(stanza, top);
      if (dropped.length > 0) options.onBindingsDropped?.(dropped);
      // The app's own Workflows, named for this scope — see `app` above for why only here, and
      // `project/appWorkflows.ts` for the one derivation both this and `pithy worker sync` write from (#650).
      if (options.app) applyAppWorkflows(stanza, planAppWorkflows(options.app, options.scope.workflowHost));
      featureCrons(stanza);
      if (options.subdomain !== undefined) stampFeatureAddress(stanza, top, options.subdomain);
    }
    for (const resource of options.resources) {
      const { array, fields } = KIND_TO_WRANGLER[resource.kind];
      // Reuse the existing comment-json array (preserving its comments) or start a fresh one, then
      // mutate in place — never replace it with a filtered plain array, which would strip
      // comment-json's symbols.
      stanza[array] ??= [];
      upsertByBinding(stanza[array], resource.binding, fields(resource));
    }
    // The self binding last, so it is written from the `name` this edit has already settled and so the
    // kit's own constant wins over anything else that claimed it. Nothing is written for a project that
    // does not declare it: no `services` key, no empty array, no change to the stanza at all.
    const services = options.administersItself
      ? [...options.services, { binding: SELF_BINDING, service: stanza.name }]
      : options.services;
    if (services.length > 0) {
      stanza.services ??= [];
      for (const entry of services) {
        const existing = stanza.services.find((candidate) => candidate.binding === entry.binding);
        if (existing) existing.service = entry.service;
        else stanza.services.push({ ...entry });
      }
    }
    if (options.secrets.length > 0) upsertSecretBindings(stanza, options.secrets);
  });
}

/**
 * **Bind a feature's app Worker to the kit hosts that deployed, and to no other (#643, F2 of the review)** — and
 * to the indexes the feature created for it.
 *
 * Written after the hosts' deploy rather than with the stanza, so a host that failed to deploy leaves no binding
 * to it: the next `pithy deploy --env feature` would otherwise ship an app Worker bound to a Workflow on a script
 * that does not exist. Every entry in `hosted` — each one this Worker declares into any kit host — is removed
 * first, and then the entries of the hosts that deployed are written back, so a re-run whose host now fails takes
 * the binding a previous run wrote with it. Each index is upserted by binding, as the feature's own.
 *
 * An edit of the **generated** config in place, not a regeneration from the tracked file: that is what the stanza
 * write above does, and a second regeneration would drop everything the first one wrote (#592). Nothing is
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
    stanza.workflows = next;
  }
  for (const index of options.indexes) {
    stanza.vectorize ??= [];
    const existing = stanza.vectorize.find((entry) => entry.binding === index.binding);
    if (existing) existing.index_name = index.name;
    else stanza.vectorize.push({ binding: index.binding, index_name: index.name });
  }
  await writeJsonc(path, config);
}
