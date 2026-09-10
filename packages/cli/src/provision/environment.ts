// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { relative } from "node:path";
import type { BindingType } from "@pithy-sh/core/src/capability/bindings";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import type { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { GLOBAL_SCOPE } from "@pithy-sh/core/src/naming/environment";
import type { FeatureResourceKind } from "@pithy-sh/core/src/naming/feature";
import type { BindingNaming, ProvisionScope } from "@pithy-sh/core/src/naming/provisionScope";
import type { CliAuditEmit } from "../audit/cliAudit";
import { composedManifests, type ManifestFault } from "../capabilities/manifests";
import { type BindingDecline, type BindingDeclines, honoredNames, workerDeclines } from "../capabilities/reconcile";
import { type ProvisionableBinding, provisionableBindings, serviceBindings } from "../feature/bindings";
import type { FeatureResource } from "../feature/manifest";
import { migrateProject } from "../migrations/run";
import { loadProject, loadProjectCloudflare, requireProjectName, type WorkerConfig } from "../project/config";
import { resolveWorkers } from "../project/workerScope";
import { seedProject } from "../seed/run";
import { AUDIT_RESOURCE_TYPE, ProvisionAuditActions, type ResourceProvisioners } from "./resources";
import type { MissingSecretBinding, SecretStoreBinding } from "./secretBindings";
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

/**
 * One Worker's declines as this run resolved them — or the fact that its declaration would not read.
 *
 * The same two-state shape `BindingDeclines` carries, and for its reason: a declaration that does not
 * parse is neither "declines nothing" nor a crash. The distinction is load-bearing here rather than
 * merely tidy — an unreadable block resolves to an empty set, so **every declined resource is created**,
 * and a run that printed no decline line for it would be indistinguishable from a project that declines
 * nothing. One typo is enough (#514).
 */
export type ProvisionedDeclines =
  /** The declaration parsed, and carries at least one entry. */
  | { state: "read"; worker: string; declines: ProvisionedDecline[] }
  /** The declaration is present and malformed, so nothing was left out for it. */
  | { state: "invalid"; worker: string; problem: string };

/**
 * One `declinedBindings` entry, as this run resolved it — the same four states {@link BindingDecline} has.
 *
 * **Every entry, not the honored ones alone.** The honored-only version shipped first, on the argument
 * that a refused or stale decline "changes nothing about what this run provisioned, and a command reports
 * what it did". That argument is the one #514 rejected for the `invalid` state, and it is no better here:
 * the likeliest typo in a decline is in the **binding name**, which resolves `unrecognized`, and a run
 * that says nothing about it is byte-identical to a project that declines nothing — the exact failure the
 * report exists to remove, reached by a shorter path than a malformed block. So all four states come out.
 * Only `honored` is a skip; the other three say, in the run that read them, that nothing was left out.
 */
export type ProvisionedDecline =
  /** Applied: this run created nothing for the binding, unless a sibling Worker still wanted it. */
  | {
      state: "honored";
      /** The binding name, as the adopter wrote it and as the capability declares it. */
      name: string;
      /** The kind of Cloudflare resource the declined binding refers to. */
      type: BindingType;
      /** The composed capability that declares it optional — the one taking its absence path. */
      capability: string;
      /** The adopter's own reason, carried so the run can print back the sentence they wrote. */
      reason: string;
      /**
       * Other Workers that declare this binding and did not decline it.
       *
       * Empty is the ordinary case and the only one where nothing was created for it. When it is not
       * empty the environment still provisioned the resource, because provisioning is per binding *name*
       * and that is how two Workers share a database — this Worker's stanza leaves it out, the sibling's
       * does not. A report that said "skipped" there would be false, and false in the direction that
       * matters: an operator would go looking for a resource that exists.
       */
      wantedBy: string[];
    }
  /** Refused: some composed capability requires the binding, or its kind cannot be declined. */
  | {
      state: "required" | "undeclinable";
      /** The binding name the adopter declined. */
      name: string;
      /** The kind of Cloudflare resource it refers to. */
      type: BindingType;
      /** The composed capability that requires it, or that declares the undeclinable kind. */
      capability: string;
      /** The adopter's stated reason, carried so the line can quote it back. */
      reason: string;
    }
  /** Stale: nothing this Worker composes declares the binding, so nothing was left out for it. */
  | {
      state: "unrecognized";
      /** The binding name the adopter declined — most often one character off the real one. */
      name: string;
      /** The adopter's stated reason, carried so the line can quote it back. */
      reason: string;
    };

/**
 * **One resource reaching, then leaving, the work loop — the run narrating itself (#515).**
 *
 * Provisioning creates real account resources over a network, one find-or-create per binding, and until
 * this it said nothing until every one of them had settled. A run against a slow account was
 * indistinguishable from a hung one, which is how an operator comes to interrupt a command that was
 * working — and `provision` is idempotent, so the cost was never a broken account, only a run nobody
 * trusted enough to leave alone.
 *
 * Two phases rather than one, because the pair is what an interrupted run is read back from: the last
 * `start` with no `settled` after it names the resource that was in flight.
 */
export type ProvisionProgressEvent =
  /** About to find-or-create. Emitted before the first Cloudflare call for this resource. */
  | {
      phase: "start";
      /** The resource name, composed from the scope — what the account will be asked about. */
      name: string;
      /** The Worker binding it backs. */
      binding: string;
      /** The kind of resource. */
      kind: FeatureResourceKind;
    }
  /** Settled: adopted or created, and recorded. Carries exactly what the report will carry for it. */
  | { phase: "settled"; resource: ProvisionedResource };

/**
 * Where a run narrates itself. **Synchronous and returning nothing**, deliberately: it writes a line to a
 * terminal, and a sink that could fail or block would put the operator's console in the failure path of
 * creating a database. A caller with nothing to say passes none, which is what `--json` does.
 */
export type ProvisionProgress = (event: ProvisionProgressEvent) => void;

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
  /**
   * **What each Worker's `declinedBindings` cost it — one entry per Worker with something to say.**
   *
   * A decline is the one input to this command that removes work, and it was the one thing the run said
   * nothing about (#514). A resource that was not created leaves no trace: the report listed what it made,
   * so a decline read correctly and a decline dropped on the floor produced byte-identical output, and
   * the only way to tell them apart was to go and look at the account. Reporting the skip is what makes
   * the declaration observable from the run that honored it.
   *
   * Empty for a project that declines nothing, which is most of them.
   */
  declined: ProvisionedDeclines[];
  /**
   * **Installed packages whose `pithy.manifest.json` is present and unusable.**
   *
   * The same fact `pithy add --list`, `pithy upgrade` and `pithy doctor` each report, in the one command
   * that creates infrastructure and the one where it had never been said (#184). What it costs here is
   * not a missing resource but a wrong one: a manifest nobody could read declares no `scope` and no
   * `resource`, so a project-global database is created under a per-environment name and the run reports
   * success — see {@link ProvisionTargets.manifestFaults} for both halves of that.
   *
   * Project-wide rather than per Worker — a package installs once per directory and every Worker sees the
   * root's copy — so it is deduped by package name. Empty on a healthy install, which is most of them.
   */
  manifestFaults: ManifestFault[];
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
  ) => Promise<{ bound: SecretStoreBinding[]; missing: MissingSecretBinding[]; minted: string[] }>;
  /**
   * Where each step is narrated as it happens. Omitted means a silent run — which is what `--json` is,
   * and what every non-CLI caller is.
   */
  onProgress?: ProvisionProgress;
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
  const { bindings, declines, wantedPerWorker, manifestFaults } = await provisionTargets({
    projectDir: options.projectDir,
    capabilities: options.capabilities,
    workers,
    scope,
  });
  const services = serviceBindings(options.capabilities).map((service) => ({
    binding: service.binding,
    service: scope.worker(resolveServiceTarget(workers, service.target)),
  }));

  const recorded: FeatureResource[] = options.record ? await options.record.load() : [];
  const byBinding = new Map(recorded.map((resource) => [`${resource.kind}:${resource.binding}`, resource]));

  const resources: ProvisionedResource[] = [];
  for (const { binding, kind, name, global } of bindings) {
    // Before the find, because the find is the first thing that can take a while. The plan the command
    // printed named this resource; this says the run has reached it.
    options.onProgress?.({ phase: "start", name, binding, kind });
    const provisioner = options.provisioners[kind];
    const found = await provisioner.find(name);
    const id = found ? found.id : (await provisioner.create(name)).id;
    const resource: FeatureResource = { kind, binding, name, id };
    // **A project-global resource never enters the record.** That file is a feature's exact-id delete
    // list, and a resource the whole project shares has no business in it: teardown deletes what it
    // finds there by id, so one branch's `destroy` would take the project's suppression list with it.
    // `featureScope` already refuses to compose a global name at all — this is the same rule stated from
    // the other end, so honoring `global` in a feature namer could never quietly become a deletion.
    if (!global) {
      byBinding.set(`${kind}:${binding}`, resource);
      await options.record?.save([...byBinding.values()]); // persist after each — a crash mid-run resumes from here.
    }
    const provisioned: ProvisionedResource = { ...resource, created: found === null };
    resources.push(provisioned);
    options.onProgress?.({ phase: "settled", resource: provisioned });

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
    // The same set the resource loop filtered on, read rather than recomputed. Resolving a Worker's
    // declines once and reading the answer twice is what keeps "created but not written" — and its
    // mirror, "written but never created" — unreachable rather than merely untested.
    const declared = wantedPerWorker.get(worker.name) ?? new Set<string>();
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
    // The entry name comes from the producer, which read the registry and knows each secret's scope.
    // Recomposing it here meant supplying one, and the only one available was `"environment"` — a wrong
    // address for every `global` secret, in the report an operator reads to go create the value.
    for (const secret of workerSecrets.missing) {
      secrets.push({ binding: secret.binding, entry: secret.entry, bound: false, minted: false });
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
    declined: reportedDeclines(declines, wantedPerWorker),
    // Read out of the same call the bindings came from — a second scan of `node_modules` would be a
    // second answer to which manifests are broken, in the report about the run the first one shaped.
    manifestFaults,
    configs,
    committed: scope.source,
  };
}

/**
 * One resource this run will find-or-create: the binding it backs, and what it is called here.
 *
 * **The name is composed once, by {@link provisionTargets}, and read by everyone else.** It used to be
 * composed twice — once for the plan the operator agrees to and once in the loop that does the work —
 * from one pure function, which was safe only for as long as the name depended on nothing but the
 * binding. #513 ends that: a name now depends on what the *manifest* says about the resource, which is a
 * read of `node_modules`, and two reads are two chances to see different files.
 */
export interface ProvisionTarget extends ProvisionableBinding {
  /** The Cloudflare name, composed from the scope and the binding's declared naming. */
  name: string;
  /**
   * Whether the resource belongs to the project rather than to this environment — `BindingSpec.scope`.
   *
   * Carried out of here rather than recomputed, because two things downstream turn on it and neither has
   * the manifest in hand: a global resource is bound identically by every environment, and it must never
   * enter a feature's teardown record.
   */
  global: boolean;
}

/** What a run is about to touch: the bindings it will provision, and the decline resolution behind them. */
export interface ProvisionTargets {
  /** Every binding this run provisions, in provision order, after each Worker's declines are resolved. */
  bindings: ProvisionTarget[];
  /** What each Worker declined, and how it resolved — the report's `declined` source. */
  declines: { worker: ProvisionWorker; resolved: BindingDeclines }[];
  /** Per Worker, the binding names that Worker declares and did not decline. */
  wantedPerWorker: Map<string, Set<string>>;
  /**
   * **Installed packages whose `pithy.manifest.json` is present and unusable — carried, because a run
   * shaped by manifests must say which ones it could not read (#184, #513 review).**
   *
   * This read `composedManifests` for the manifests and dropped the faults on the floor, and the run
   * carried on around the hole rather than failing at it — which is worse than a missing resource,
   * because both things a manifest decides here go **silently wrong** rather than absent:
   *
   * - **The name.** Since #513, `scope` and `resource` come out of these files. A manifest nobody could
   *   read declares neither, so a project-global resource is composed `<project>-<env>-<binding>` — the
   *   split #513 exists to remove, reintroduced by a file that would not parse, with the run reporting
   *   success. The disagreement refusals below cannot see it either: a declaration nobody read collides
   *   with nothing.
   * - **The declines.** `workerDeclines` resolves a `declinedBindings` entry against these manifests, so
   *   one that will not parse turns an honored decline into `unrecognized` — the resource is created and
   *   the binding written back into the file the adopter removed it from (#440, #514).
   *
   * Reported rather than refused, on `availableManifests`' own standard: one broken package must not take
   * the other fifteen capabilities' provisioning with it. Empty on a healthy install.
   */
  manifestFaults: ManifestFault[];
}

/**
 * **The one answer to "what will this run touch", for the run and for the plan it prints (#515).**
 *
 * `pithy provision` prints a plan before it asks an operator to agree to real Cloudflare resources, and a
 * plan is only worth printing if it cannot drift from the work: a plan computed from
 * `provisionableBindings(capabilities)` alone would list a resource every declining Worker had removed,
 * and the run that followed would silently create fewer things than it announced. So the command and the
 * loop below call *this*, with the same Worker set, and the plan is the loop's own input rather than a
 * second guess at it.
 */
export async function provisionTargets(options: {
  /** The project root — where each Worker's composed manifests are resolved from. */
  projectDir: string;
  /** Every capability the environment spans, deduped by name. The source of the binding *kinds*. */
  capabilities: readonly Capability[];
  /** The resolved Workers, each carrying its own capabilities and its own `declinedBindings`. */
  workers: readonly ProvisionWorker[];
  /** What everything is named. The plan and the loop take the names from here, not from a second call. */
  scope: ProvisionScope;
}): Promise<ProvisionTargets> {
  const { workers } = options;
  // **Declines are per Worker, and a resource survives one Worker declining it.** The environment
  // provisions one resource per binding *name* — that is how two Workers share a database — so a binding
  // is skipped only when every Worker that declares it declines it. Resolved through the reconcile
  // engine's own rule so `pithy upgrade` and `pithy provision` cannot come to mean two different things
  // by "declined" (#440).
  //
  // **Per Worker, from that Worker's own `node_modules` as well as the root's (#507).** This read the root
  // alone, which is where the fix for #440 stopped short: a capability declared only on the Worker
  // composing it — the shape the kit tells adopters to adopt — installs under `apps/<name>/node_modules`,
  // so the root scan found no manifest, the decline resolved as `unrecognized`, and provisioning created
  // the resource and wrote the binding back into a file the adopter had removed it from (#514). The two
  // manifest sets are not merged into one list: two Workers may pin a capability differently, and
  // resolving each Worker against what *it* loads is the point.
  //
  // **No `ejected` here, and that is the one place this parts from `buildReconcilePlan` — deliberately.**
  // An upgrade skips a forked capability outright (`if (ejected.includes(manifest.name)) continue;`), so
  // it writes nothing for one and a decline of a fork's binding costs it nothing either way. Provisioning
  // does the opposite: it decides what to create from the **composed instances**, and a fork is composed,
  // so its `r2 SUPPORT_BUCKET` is created and written into the stanza like any other binding. Dropping the
  // fork's manifest from this resolution resolves the decline as `unrecognized`, creates the bucket, and
  // writes the binding back into the file the adopter had removed it from — #440 again, for the one
  // capability whose code the adopter owns, and silently, because an unrecognized decline is not a skip.
  //
  // A fork that has drifted from its manifest is already covered without it: `resolveDeclines` refuses a
  // decline the composed *instance* declares non-optionally, so a fork that made the binding required
  // refuses the decline whatever its manifest still says.
  const declinedPerWorker = new Map<string, ReadonlySet<string>>();
  const declines: { worker: ProvisionWorker; resolved: BindingDeclines }[] = [];
  // Every Worker's manifests, kept rather than dropped: they are also where a binding's `scope` and
  // `resource` are declared, and re-reading `node_modules` a second time to ask is a second answer.
  const declared: CapabilityManifest[] = [];
  // Deduped by package, because manifests resolve per Worker from two directories and every Worker in a
  // project sees the root's copy: a project with three Workers and one broken package must say it once.
  const faults = new Map<string, ManifestFault>();
  for (const worker of workers) {
    const { manifests, faults: workerFaults } = await composedManifests(options.projectDir, worker.dir);
    declared.push(...manifests);
    for (const fault of workerFaults) if (!faults.has(fault.package)) faults.set(fault.package, fault);
    const resolved = workerDeclines({ manifests, capabilities: worker.capabilities, workerConfig: worker.config });
    declines.push({ worker, resolved });
    declinedPerWorker.set(worker.name, honoredNames(resolved));
  }
  const wantedPerWorker = new Map(
    workers.map((worker) => [
      worker.name,
      new Set(provisionableBindings(worker.capabilities, declinedPerWorker.get(worker.name)).map((b) => b.binding)),
    ]),
  );
  const wantedSomewhere = new Set([...wantedPerWorker.values()].flatMap((wanted) => [...wanted]));
  // The union is still the source of the *kinds* — `options.capabilities` spans the environment, and a
  // Worker resolver seam may hand back fewer Workers than that union was built from. Only names no
  // Worker wants are dropped.
  //
  // **No Workers resolved provisions the caller's union whole, deliberately.** A decline is a *Worker's*
  // statement, so with no Worker there is no statement, and the filter has nothing to say rather than
  // everything: reading an empty `wantedSomewhere` as "nothing is wanted" would turn a resolver that came
  // back empty into a silent no-op run reporting success. Unreachable from `pithy provision --env`, which
  // enumerates `apps/*`; reachable through the `resolveWorkers` seam `provisionFeature` forwards.
  const wanted = provisionableBindings(options.capabilities).filter(
    (binding) => workers.length === 0 || wantedSomewhere.has(binding.binding),
  );
  const namings = resolveBindingNamings({
    manifests: declared,
    capabilities: new Set(options.capabilities.map((capability) => capability.name)),
    bindings: wanted,
    scope: options.scope,
  });
  const bindings = wanted.map(({ binding, kind }) => {
    // A binding no manifest declares keeps the generic name it has always had. That is the adopter's own
    // `app` capability, which has bindings and no npm package to ship a manifest — and a fork whose
    // manifest was removed. Neither is a missing declaration; both are "nothing to say", which is `{}`.
    const declared = namings.get(binding);
    const declaredNaming = declared?.naming ?? {};
    return {
      binding,
      kind,
      // Read from the resolution rather than composed again — one string, composed once, for the
      // refusals above, the plan the operator agrees to, and the run that follows it.
      name: declared?.name ?? options.scope.resource(binding, kind, declaredNaming),
      // **Asked of the scope, not of the manifest alone.** A feature ignores `global` and names its own
      // copy, so reading the declaration by itself would mark that copy the project's, keep it out of the
      // teardown record, and orphan it on `destroy`.
      global: declaredNaming.scope === GLOBAL_SCOPE && options.scope.honorsGlobal,
    };
  });
  return { bindings, declines, wantedPerWorker, manifestFaults: [...faults.values()] };
}

/** One binding's declared naming, and who declared it — everything a refusal below needs to name. */
interface DeclaredNaming {
  /** The manifest that declared it. */
  capability: string;
  /** What it says about the resource's name: `BindingSpec.scope` and `BindingSpec.resource`. */
  naming: BindingNaming;
  /** What that composes to in this scope — the string two declarations must agree on. */
  name: string;
}

/**
 * **What each binding's resource is called, from the manifests — and the two things that must be true
 * before a run creates anything (#513).**
 *
 * An environment provisions **one resource per binding name**: that is how two Workers share a database,
 * and it is what makes the binding name the resource's identity. `scope` and `resource` are the first
 * fields that can break that identity from either end, so both ends are checked here, once, before the
 * first Cloudflare call — a refusal after the third resource is created is a half-provisioned account.
 *
 * The manifest is the only source, and only for capabilities this environment actually composes.
 * Something installed under `node_modules` that no Worker composes declares nothing about this run, and a
 * binding no Worker will provision cannot collide with one that will — so a project is never refused for
 * a conflict it could not reach.
 */
function resolveBindingNamings(options: {
  /** Every composed Worker's manifests, as read from its own `node_modules` and the root's. */
  manifests: readonly CapabilityManifest[];
  /** The capability names this environment composes — manifests outside it are not this run's business. */
  capabilities: ReadonlySet<string>;
  /** The bindings this run will provision, after declines. Nothing outside it can collide with anything. */
  bindings: readonly ProvisionableBinding[];
  /** The scope every name is composed in. Two declarations disagree when their *composed names* differ. */
  scope: ProvisionScope;
}): Map<string, DeclaredNaming> {
  const kinds = new Map(options.bindings.map((binding) => [binding.binding, binding.kind]));
  const byBinding = new Map<string, DeclaredNaming>();
  for (const manifest of options.manifests) {
    if (!options.capabilities.has(manifest.name)) continue;
    for (const spec of manifest.requiredBindings) {
      const kind = kinds.get(spec.name);
      if (kind === undefined) continue;
      const naming: BindingNaming = {
        ...(spec.scope ? { scope: spec.scope } : {}),
        ...(spec.resource ? { resource: spec.resource } : {}),
      };
      const declaredNaming: DeclaredNaming = {
        capability: manifest.name,
        naming,
        name: options.scope.resource(spec.name, kind, naming),
      };
      const seen = byBinding.get(spec.name);
      if (seen === undefined) {
        byBinding.set(spec.name, declaredNaming);
        continue;
      }
      if (seen.name === declaredNaming.name) continue;
      // **First-wins would let `readdir` order decide where a project's data lives.** Two capabilities
      // declaring one binding name are declaring one resource — the environment creates exactly one — so
      // a disagreement about its `scope` or its `resource` is a disagreement about *which* resource, and
      // whichever manifest happened to be read second would silently lose. The composed names are what
      // the refusal states, because they are the two things that cannot both be true.
      throw new ValidationError({
        message: `Two capabilities disagree about the resource behind "${spec.name}": ${seen.capability} names it ${seen.name}, ${manifest.name} names it ${declaredNaming.name}.`,
        action: `One binding name is one resource. Have ${seen.capability} and ${manifest.name} declare the same scope and resource for ${spec.name}, or give one of them a binding name of its own.`,
      });
    }
  }

  // **The other end, and nothing else would catch it.** `resource` is what removes the property that made
  // the binding name unique — two different bindings may now compose one name, and a run would create one
  // resource, adopt it on the second pass, and hand two capabilities a store each believes is its own.
  // Grouped per kind, because Cloudflare's namespaces are per kind: a D1 database and an R2 bucket of one
  // name are two resources, and refusing that pair would refuse a project that is fine.
  const byName = new Map<string, { binding: string; declaredNaming: DeclaredNaming }>();
  for (const [binding, declaredNaming] of byBinding) {
    const key = `${kinds.get(binding)}:${declaredNaming.name}`;
    const seen = byName.get(key);
    if (seen === undefined) {
      byName.set(key, { binding, declaredNaming });
      continue;
    }
    throw new ValidationError({
      message: `${seen.declaredNaming.capability}'s ${seen.binding} and ${declaredNaming.capability}'s ${binding} both name ${declaredNaming.name}.`,
      action: `Two bindings backed by one resource is a resource neither owns. Change the resource on one of them, or have them share a binding name if they mean to share the resource.`,
    });
  }
  return byBinding;
}

/**
 * The decline lines this run earned: one entry per Worker that declined something, or could not be read.
 *
 * A Worker that declines nothing contributes nothing — the ordinary project reports an empty list rather
 * than one empty entry per Worker, so a `--json` consumer can branch on the array itself.
 */
function reportedDeclines(
  resolved: readonly { worker: ProvisionWorker; resolved: BindingDeclines }[],
  wantedPerWorker: ReadonlyMap<string, ReadonlySet<string>>,
): ProvisionedDeclines[] {
  const entries: ProvisionedDeclines[] = [];
  for (const { worker, resolved: declines } of resolved) {
    if (declines.state === "invalid") {
      entries.push({ state: "invalid", worker: worker.name, problem: declines.problem });
      continue;
    }
    if (declines.declines.length === 0) continue;
    entries.push({
      state: "read",
      worker: worker.name,
      declines: declines.declines.map((decline) => reportedDecline(decline, worker.name, wantedPerWorker)),
    });
  }
  return entries;
}

/** One resolved entry, projected onto what a provisioning run can say about it. */
function reportedDecline(
  decline: BindingDecline,
  worker: string,
  wantedPerWorker: ReadonlyMap<string, ReadonlySet<string>>,
): ProvisionedDecline {
  if (decline.state === "unrecognized") return { state: "unrecognized", name: decline.name, reason: decline.reason };
  const { name, type, capability, reason } = decline;
  if (decline.state !== "honored") return { state: decline.state, name, type, capability, reason };
  return {
    state: "honored",
    name,
    type,
    capability,
    reason,
    // Every other Worker that declares this binding and wants it. Computed from the same per-Worker
    // sets the resource loop filtered on, so the report cannot claim a skip the run did not take.
    //
    // `stillPresentIn` is deliberately not mirrored here: `resolveDeclines` fills it from stanzas, and
    // this call passes none. What an earlier run left behind is a separate fact, and the human line says
    // "not created by this run" rather than pretending to know the account (#514 review).
    wantedBy: [...wantedPerWorker].filter(([other, wanted]) => other !== worker && wanted.has(name)).map(([o]) => o),
  };
}
