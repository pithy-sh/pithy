// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative } from "node:path";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import type { ProvisionScope } from "@pithy-sh/core/src/naming/provisionScope";
import type { CliAuditEmit } from "../audit/cliAudit";
import { availableManifests } from "../capabilities/manifests";
import { honoredDeclineNames } from "../capabilities/reconcile";
import { provisionableBindings, serviceBindings } from "../feature/bindings";
import type { FeatureResource } from "../feature/manifest";
import { migrateProject } from "../migrations/run";
import { loadProject, loadProjectCloudflare, requireProjectName, type WorkerConfig } from "../project/config";
import { resolveWorkers } from "../project/workerScope";
import { seedProject } from "../seed/run";
import { AUDIT_RESOURCE_TYPE, ProvisionAuditActions, type ResourceProvisioners } from "./resources";
import type { SecretStoreBinding } from "./secretBindings";
import { applyProvisionedEnv, type ServiceEntry } from "./wranglerEnv";

/**
 * **Standing up one environment's own Cloudflare resources — for any environment a project has.**
 *
 * This was written for ephemeral feature environments and was never generalized, which is the single
 * cause of three reported defects: a declared `staging` got no resources at all (#240), a feature got
 * every resource except its secrets (#239), and a deployed Worker got no Secrets Store bindings (#238).
 * The machinery was always general — it resolves the Worker set, provisions one resource per binding
 * name, writes ids into each Worker's own config, then migrates and seeds. Only the *namer* was
 * feature-shaped, and only the command surface was missing.
 *
 * So the environment is not a parameter here. A {@link ProvisionScope} is, and it carries both the names
 * and the stanza they are written into — see `@pithy-sh/core/src/naming/provisionScope` for why those
 * two were never safe as separate arguments.
 *
 * Idempotent and resumable: every resource is matched by name before it is created, so a re-run reuses
 * what exists, a hand-created resource of the right name is **adopted** rather than duplicated, and a
 * run interrupted by a network hiccup completes on the next attempt.
 */

/** A migrate/seed seam so provisioning's orchestration is testable without a live backend. */
export type BackendRunner = (args: { env: string; projectDir: string }) => Promise<void>;

// The migrate names its project for the same reason the seed below does, and one more: the stamp it
// writes is what refuses a later run from another project. A fresh environment's D1 is brand new, so
// this run is the one that adopts it — skip the name here and the database stays unowned for good.
const defaultMigrate: BackendRunner = async ({ env, projectDir }) => {
  // One config load, two facts, both from the project's own root config: the project the brand-new D1 is
  // stamped for, and the account it is created and migrated in. A provisioned environment is remote by
  // definition, so this is the account that decides *whose tenant* the schema lands in (#234).
  const config = await loadProject(projectDir);
  await migrateProject({
    env,
    projectDir,
    project: requireProjectName(config),
    account: loadProjectCloudflare(config) ?? null,
  });
};

// The seed names its project because a fixture can mint Cloudflare Images/Stream assets, and those two
// account-flat stores carry no name we chose — only the owner in their metadata. `requireProjectName`,
// the same resolver every provisioned resource name already leads with.
const defaultSeed: BackendRunner = async ({ env, projectDir }) => {
  const config = await loadProject(projectDir);
  await seedProject({
    env,
    projectDir,
    project: requireProjectName(config),
    account: loadProjectCloudflare(config) ?? null,
    yes: true,
    json: true,
  });
};

/**
 * Where a run's resource ids are recorded **outside** the wrangler stanza, when the scope wants that.
 *
 * A feature has one: its resources are ephemeral and something has to be able to delete them exactly,
 * including after a run that failed between creating a resource and writing the config. A declared
 * environment has none — its record *is* the `wrangler.jsonc` stanza, which is source, reviewed, and
 * long-lived. Optional rather than defaulted to a file, so "this environment keeps no side record" is a
 * decision a caller made rather than a path nobody noticed.
 */
export interface ProvisionRecord {
  /** Everything a previous run recorded that this scope could legitimately have created. */
  load(): Promise<FeatureResource[]>;
  /** Persist the running set. Called after each resource, so an interrupted run resumes from here. */
  save(resources: FeatureResource[]): Promise<void>;
}

/** One provisioned resource in the report: what it is, and whether this run created it or adopted it. */
export interface ProvisionedResource extends FeatureResource {
  /** True when this run created the resource; false when it already existed (re-run, or adoption). */
  created: boolean;
}

/**
 * The structured outcome of a provisioning run — the `--json` payload and the human summary source.
 *
 * **No `migrated`/`seeded` pair, for the reason `CreateReport` states (#231).** Both were literal `true`s
 * beside the two `await`s that ran the steps, and both steps throw, so the report's own existence already
 * carried the fact. A constant is not a field.
 */
export interface ProvisionReport {
  /** The environment provisioned — the scope's stanza. */
  env: string;
  /** Every resource, in provision order, flagged created vs. adopted. */
  resources: ProvisionedResource[];
  /** Each Worker and the script name it deploys under in this environment. */
  workers: { worker: string; name: string }[];
  /** Each service binding and the Worker it now targets in this environment. */
  services: ServiceEntry[];
  /** Every `cf-secrets-store` secret this environment declares, and whether it was bound. */
  secretBindings: ProvisionedSecret[];
  /** Where each Worker's ids were written, project-relative — one entry per Worker, in write order. */
  configs: ProvisionedConfig[];
  /**
   * **Are the files above committed, or ignored?** `true` for a declared environment, whose ids are
   * long-lived source a human reviews in a pull request; `false` for a feature, whose ids are one job's
   * output under the already-ignored `.wrangler/`.
   *
   * One flag now decides which of those a run produces, and a flag that flips whether output is committed
   * will eventually surprise someone. So the run says which it did, here and in the human summary — and
   * a pipeline can read the answer rather than infer it, which is what keeps *a CI build never commits
   * back to the repository* a property a script can assert.
   *
   * One boolean for the whole run rather than one per config: a scope is chosen once, so a per-file copy
   * would be N copies of one fact, and every consumer branch on a disagreement they cannot have.
   */
  committed: boolean;
}

/** One file a provisioning run wrote a Worker's ids into. */
export interface ProvisionedConfig {
  /** The Worker's own deploy name — its `wrangler.jsonc` `name`. */
  worker: string;
  /** The file written, relative to the project root. */
  path: string;
  /** How many binding ids landed in it. Zero for a Worker that declares no provisionable binding. */
  ids: number;
}

/** One declared Secrets Store secret, and whether the environment now binds it. */
export interface ProvisionedSecret {
  /** The Worker binding name, which is the registry key. */
  binding: string;
  /** The store entry it resolves to in this environment. */
  entry: string;
  /**
   * True when the entry exists and the binding was written. False when the secret is declared and its
   * entry has never been created — bound anyway, wrangler would refuse the whole config, so one absent
   * value would fail the Worker's deploy rather than one read.
   */
  bound: boolean;
  /**
   * True when **this run** created the value, because the registry declared it may be minted (#321).
   *
   * Reported for the same reason a created resource is distinguished from an adopted one: a run that
   * generated a key-encryption key did something an operator needs to be able to see in the log, and a
   * re-run that found one already there did not. The value itself is nowhere — here or anywhere.
   */
  minted: boolean;
}

/** One Worker as provisioning needs it: where it lives, and what *it* composes. */
export interface ProvisionWorker {
  /** The Worker's deploy name — its `wrangler.jsonc` `name` — which the scoped script name derives from. */
  name: string;
  /** The Worker's directory — the `wrangler.jsonc` this run writes into, and the `apps/<name>` a sibling's service binding names it by. */
  dir: string;
  /** That Worker's own capabilities, from its `apps/<name>/pithy.config.ts`. */
  capabilities: Capability[];
  /**
   * That Worker's own `pithy.config.ts`. Only `declinedBindings` is read from it — a binding this Worker
   * declines gets no resource created for it, because the decline said the resource is not wanted.
   * Optional: the resolver is a seam, and a caller with no config to give is a Worker declining nothing.
   */
  config?: WorkerConfig;
}

/** Options for {@link provisionEnvironment}. */
export interface ProvisionEnvironmentOptions {
  /** The project root — where `apps/` lives. */
  projectDir: string;
  /** The scope: what the resources are named, and which `env.<name>` stanza their ids are written into. */
  scope: ProvisionScope;
  /**
   * Every capability the environment spans — the union of each Worker's own `apps/<name>/pithy.config.ts`,
   * deduped by name. It is a union rather than a per-Worker loop because an environment is one
   * environment: `provisionableBindings` dedupes by **binding name**, and sharing is keyed on exactly that
   * — two Workers that both declare `DB` get one database, and a Worker wanting its own declares a
   * different binding.
   */
  capabilities: Capability[];
  /** The provisioners to create through (`cloudflareProvisioners` over live CF clients in a real run). */
  provisioners: ResourceProvisioners;
  /** A side record of what was created, for a scope whose resources are torn down automatically. */
  record?: ProvisionRecord;
  /**
   * Whether to load seed data once the schema is up.
   *
   * **Required, and a word each caller writes down.** A feature environment is created empty and is
   * useless without fixtures, so it always seeds. A declared environment already holds real rows, and
   * "provisioning quietly also seeded staging" is not a default anyone should have to discover. A
   * boolean with a default here would have made those two the same decision made once, by whoever
   * wrote the default.
   */
  seedData: boolean;
  /** Migration runner seam (default: `migrateProject`). */
  migrate?: BackendRunner;
  /** Seed runner seam (default: `seedProject`). */
  seed?: BackendRunner;
  /**
   * Worker-resolution seam (default: {@link resolveWorkers}), so tests fix the worker set. Each entry
   * carries that Worker's **own** capabilities, which is what lets the write step give a Worker only
   * the bindings it declares.
   */
  resolveWorkers?: (projectDir: string) => Promise<ProvisionWorker[]>;
  /**
   * This Worker's `secrets_store_secrets` entries, named for the scope — the stanza `pithy add` could
   * not write. Omitted when no account or store id is in hand, in which case no stanza is written and
   * nothing already there is disturbed.
   */
  secretBindings?: (
    capabilities: Capability[],
  ) => Promise<{ bound: SecretStoreBinding[]; missing: string[]; minted: string[] }>;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
  /**
   * Extra metadata every creation event carries — what makes a feature's trail say *which* feature.
   * The scope knows the names; only the caller knows why this environment exists.
   */
  auditMetadata?: Record<string, unknown>;
}

/**
 * The real worker resolver: every Worker under `apps/`, each with its own capabilities loaded from its
 * `apps/<name>/pithy.config.ts`.
 */
const defaultResolveWorkers = async (projectDir: string): Promise<ProvisionWorker[]> =>
  (await resolveWorkers({ projectDir })).map((worker) => ({
    name: worker.name,
    dir: worker.dir,
    capabilities: worker.capabilities,
    config: worker.config,
  }));

/**
 * Resolve a `service` binding's target to the script name that Worker actually deploys under.
 *
 * A service binding names its target as it appears in `apps/<name>/` (`BindingSpec.service`), but a Worker
 * deploys under its `wrangler.jsonc` `name` — and the two diverge routinely (`pithy init replay` writes
 * `apps/board/wrangler.jsonc` with `"name": "replay-board"`). Scoping the directory name would point the
 * binding at a script nobody deploys: RPC through that binding fails and provisioning reports success. So
 * both sides go through the resolved Worker set, which carries the deploy name, and the directory basename
 * is only the key.
 *
 * A target that matches no Worker is refused rather than guessed: provisioning writes an `env.<name>`
 * stanza only for the Workers it resolved, so nothing else can be scoped correctly, and a silently
 * dangling service name is the exact failure this resolution exists to remove.
 */
function resolveServiceTarget(workers: readonly ProvisionWorker[], target: string): string {
  const found = workers.find((worker) => worker.name === target || worker.dir.endsWith(`/${target}`));
  if (!found) {
    throw new ValidationError({
      message: `A service binding targets "${target}", which is not one of this project's workers.`,
      action: `Name the target as its apps/<name> directory. Known: ${workers.map((worker) => worker.name).join(", ") || "none"}.`,
    });
  }
  return found.name;
}

/**
 * Provision (or resume provisioning) one environment's Cloudflare resources. For each provisionable
 * binding: compute its name from the scope, adopt the resource if one of that name already exists, else
 * create it, and record it. Then write the ids, the scoped script name, and the retargeted service
 * bindings into **each Worker's own** `wrangler.jsonc`, and run remote migrate + seed (both idempotent).
 * Returns a report; safe to re-run.
 */
export async function provisionEnvironment(options: ProvisionEnvironmentOptions): Promise<ProvisionReport> {
  const audit = options.audit ?? (async () => {});
  const { scope } = options;
  // Resolve the Workers first. Their deploy names are what every service binding is retargeted at, so an
  // unresolvable target must fail here — before a single Cloudflare resource is created.
  const workers = await (options.resolveWorkers ?? defaultResolveWorkers)(options.projectDir);

  // **Declines are per Worker, and a resource survives one Worker declining it.** The environment
  // provisions one resource per binding *name* — that is how two Workers share a database — so a binding
  // is skipped only when every Worker that declares it declines it. Resolved through the reconcile
  // engine's own `honoredDeclineNames` so `pithy upgrade` and `pithy provision` cannot come to mean two
  // different things by "declined" (#440).
  const manifests = (await availableManifests(options.projectDir)).manifests;
  const declinedPerWorker = new Map<string, ReadonlySet<string>>();
  for (const worker of workers) {
    declinedPerWorker.set(
      worker.name,
      honoredDeclineNames({ manifests, capabilities: worker.capabilities, workerConfig: worker.config }),
    );
  }
  const wantedSomewhere = new Set(
    workers.flatMap((worker) =>
      provisionableBindings(worker.capabilities, declinedPerWorker.get(worker.name)).map((b) => b.binding),
    ),
  );
  // The union is still the source of the *kinds* — `options.capabilities` spans the environment, and a
  // Worker resolver seam may hand back fewer Workers than that union was built from. Only names no
  // Worker wants are dropped.
  const bindings = provisionableBindings(options.capabilities).filter(
    (binding) => workers.length === 0 || wantedSomewhere.has(binding.binding),
  );
  const services = serviceBindings(options.capabilities).map((service) => ({
    binding: service.binding,
    service: scope.worker(resolveServiceTarget(workers, service.target)),
  }));

  const recorded: FeatureResource[] = options.record ? await options.record.load() : [];
  const byBinding = new Map(recorded.map((resource) => [`${resource.kind}:${resource.binding}`, resource]));

  const resources: ProvisionedResource[] = [];
  for (const { binding, kind } of bindings) {
    const name = scope.resource(binding, kind);
    const provisioner = options.provisioners[kind];
    const found = await provisioner.find(name);
    const id = found ? found.id : (await provisioner.create(name)).id;
    const resource: FeatureResource = { kind, binding, name, id };
    byBinding.set(`${kind}:${binding}`, resource);
    await options.record?.save([...byBinding.values()]); // persist after each — a crash mid-run resumes from here.
    resources.push({ ...resource, created: found === null });

    // Record only a genuine creation; a run that adopted an existing resource changed nothing.
    if (!found) {
      await audit({
        environment: scope.stanza,
        action: ProvisionAuditActions.resourceCreated,
        outcome: "success",
        resourceType: AUDIT_RESOURCE_TYPE[kind],
        resourceId: id,
        metadata: { ...options.auditMetadata, name, binding },
      });
    }
  }

  // Write the ids, the scoped script name, and the service targets into **each Worker's own**
  // `wrangler.jsonc` — the file wrangler actually reads, and the file `migrate`/`seed` resolve binding ids
  // from. There is no root Worker: every Worker lives in `apps/<name>/` and owns its wrangler config.
  //
  // **A Worker receives only the bindings its own config declares.** The run provisions one resource per
  // binding name across the whole environment (that is how two Workers share a database — same binding
  // name, same resource), but the *wiring* is per Worker: handing a Worker ids for resources it never
  // declared would put bindings in its wrangler config that it has no business holding.
  const secrets: ProvisionedSecret[] = [];
  const configs: ProvisionedConfig[] = [];
  for (const worker of workers) {
    const declared = new Set(
      provisionableBindings(worker.capabilities, declinedPerWorker.get(worker.name)).map((binding) => binding.binding),
    );
    const workerSecrets = (await options.secretBindings?.(worker.capabilities)) ?? {
      bound: [],
      missing: [],
      minted: [],
    };
    const minted = new Set(workerSecrets.minted);
    for (const entry of workerSecrets.bound) {
      secrets.push({
        binding: entry.binding,
        entry: entry.secret_name,
        bound: true,
        minted: minted.has(entry.binding),
      });
    }
    for (const binding of workerSecrets.missing) {
      secrets.push({ binding, entry: scope.secretEntry(binding, "environment"), bound: false, minted: false });
    }
    const written = resources.filter((resource) => declared.has(resource.binding));
    const destination = await applyProvisionedEnv({
      workerDir: worker.dir,
      worker: worker.name,
      scope,
      resources: written,
      secrets: workerSecrets.bound,
      // Likewise: only the service bindings this Worker declares, retargeted at this environment's copy.
      services: serviceBindings(worker.capabilities).map((service) => ({
        binding: service.binding,
        service: scope.worker(resolveServiceTarget(workers, service.target)),
      })),
    });
    // The path the writer wrote, taken from the writer — never recomputed here. A report that names one
    // file while another was edited is the failure the report exists to prevent (#251).
    configs.push({ worker: worker.name, path: relative(options.projectDir, destination), ids: written.length });
  }

  const migrate = options.migrate ?? defaultMigrate;
  const seed = options.seed ?? defaultSeed;
  // migrate and seed fan out over the Workers themselves, each against its own wrangler.jsonc — the file
  // this run just wrote the environment's binding ids into.
  await migrate({ env: scope.stanza, projectDir: options.projectDir });
  if (options.seedData) await seed({ env: scope.stanza, projectDir: options.projectDir });

  return {
    env: scope.stanza,
    resources,
    workers: workers.map((worker) => ({ worker: worker.name, name: scope.worker(worker.name) })),
    services,
    secretBindings: secrets,
    configs,
    committed: scope.source,
  };
}
