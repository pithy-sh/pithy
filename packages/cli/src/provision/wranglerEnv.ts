// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import type { ProvisionScope, ProvisionWorkerNames } from "@pithy-sh/core/src/naming/provisionScope";
import { BASE_URL_VAR, SELF_BINDING } from "@pithy-sh/core/src/worker/identity";
import { parse } from "comment-json";
import type { HostedWorkflowEntry } from "../feature/hosts";
import type { FeatureResource } from "../feature/manifest";
import { featureNamespaceId } from "../feature/ratelimits";
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
  workflows?: HostedWorkflowEntry[];
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
      const dropped = stripFeatureRoutes(stanza, top);
      if (dropped.length > 0) options.onRoutesDropped?.(dropped);
      featureRatelimits(stanza as Record<string, unknown>, top);
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
