// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { rm } from "node:fs/promises";
import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import {
  type FeatureIdentity,
  type FeatureResourceKind,
  featureResourceName,
  featureWorkerName,
} from "@pithy-sh/core/src/naming/feature";
import type { CliAuditEmit } from "../audit/cliAudit";
import { migrateProject } from "../migrations/run";
import { loadProject, loadProjectCloudflare, requireProjectName } from "../project/config";
import { resolveWorkers } from "../project/workerScope";
import { seedProject } from "../seed/run";
import { provisionableBindings, serviceBindings } from "./bindings";
import {
  emptyManifest,
  type FeatureManifest,
  type FeatureResource,
  manifestPath,
  readManifest,
  upsertResource,
  writeManifest,
} from "./manifest";
import { applyProvisionedIds, applyWorkerEnv } from "./wranglerEnv";

/**
 * `pithy feature provision` stands up a feature's live Cloudflare environment: one ephemeral resource per
 * provisionable binding name the feature's Workers declare between them, named under the branch-first
 * prefix, then remote migrate + seed. It is idempotent and resumable — every resource is matched by name before creating, so a
 * network hiccup or mid-run error leaves a partial environment that re-running completes, skipping what
 * exists and creating only what is missing. `destroy` reverses it: delete the manifest's resources, then
 * reconcile by prefix-scan so a partial-failed provision still cleans up fully.
 */

/** The control-plane operations `pithy feature` needs for one resource kind. Injectable so tests fake CF. */
export interface ResourceProvisioner {
  /** Find a resource by its exact name, returning its id, or null when absent (id = uuid/nsId, or the bucket name for r2). */
  find(name: string): Promise<{ id: string } | null>;
  /** Create the resource by name and return its id. */
  create(name: string): Promise<{ id: string }>;
  /** Delete the resource by id. Idempotent — a missing resource is not an error. */
  delete(id: string): Promise<void>;
}

/** One provisioner per provisionable resource kind. */
export type FeatureProvisioners = Record<FeatureResourceKind, ResourceProvisioner>;

/**
 * The default provisioners, backed by the `@pithy-sh/cloudflare` control-plane clients. For D1 and KV the
 * id is the CF-assigned uuid/namespace id; for R2, which has no separate id, the bucket name is the id.
 *
 * **Known limitation, R2 only:** the delete here is the plain control-plane one, and R2 refuses to delete
 * a bucket that still holds an object or a dangling multipart upload — so a feature bucket that was
 * written to fails teardown. Emptying it first needs the S3 key pair, which the control-plane clients do
 * not carry (`pithy storage deprovision --storage` takes it as a flag for exactly this reason). Wiring
 * that through the feature lifecycle is the fix; until then, empty the bucket by hand.
 */
export function cloudflareProvisioners(clients: CloudflareClients): FeatureProvisioners {
  const d1 = clients.d1Provisioner();
  const kv = clients.kvProvisioner();
  const r2 = clients.r2Provisioner();
  return {
    d1: {
      find: async (name) => {
        const found = await d1.findDatabaseByName(name);
        return found ? { id: found.uuid } : null;
      },
      create: async (name) => ({ id: (await d1.createDatabase(name)).uuid }),
      delete: (id) => d1.deleteDatabase(id),
    },
    kv: {
      find: async (name) => {
        const found = await kv.findNamespaceByTitle(name);
        return found ? { id: found.id } : null;
      },
      create: async (name) => ({ id: (await kv.createNamespace(name)).id }),
      delete: (id) => kv.deleteNamespace(id),
    },
    r2: {
      find: async (name) => {
        const found = await r2.findBucketByName(name);
        return found ? { id: found.name } : null;
      },
      create: async (name) => ({ id: (await r2.createBucket(name)).name }),
      delete: (id) => r2.deleteBucket(id),
    },
  };
}

/**
 * Audit actions the feature lifecycle records. Provisioning and — especially — teardown change real
 * infrastructure, and `destroy` runs headlessly in CI, so "who deleted this, and what exactly went?" must
 * be answerable after the fact.
 */
export const FeatureAuditActions = {
  /** A Cloudflare resource was created for the feature. */
  resourceCreated: "feature/resource_created",
  /** A Cloudflare resource was deleted during teardown. */
  resourceDeleted: "feature/resource_deleted",
} as const;

/** The resource kind recorded on a feature audit event. */
const AUDIT_RESOURCE_TYPE: Record<FeatureResourceKind, string> = {
  d1: "cf_d1",
  kv: "cf_kv",
  r2: "cf_r2",
};

/**
 * Whether a manifest entry is one **this** feature could have created.
 *
 * The manifest is a file in the worktree, so it is repository content, not a trusted record: a branch can
 * carry a crafted `.pithy-feature.json` (git-ignored stops an accidental commit, not `git add -f`, and does
 * nothing for an already-tracked file on a fetched branch). Deleting an id straight out of it would make the
 * file an unauthenticated "delete this resource" instruction — and `destroy` runs headlessly in CI, with a
 * live token, against a branch that may have come from anyone.
 *
 * So an entry is honoured only when its recorded name is exactly the name `provision` would have generated
 * for that binding and kind under this identity. The check needs nothing from the file but the entry's own
 * `binding`/`kind`, so a legitimate record still validates even after its capability is removed from config.
 */
function isOwnedByFeature(identity: FeatureIdentity, resource: FeatureResource): boolean {
  return resource.name === featureResourceName(identity, resource.binding, resource.kind);
}

/**
 * Reject a manifest whose header names a different feature. The per-entry name check below is the real
 * control, but a mismatched header means the file was authored for something else entirely — failing loudly
 * beats silently ignoring every entry, which would look like a successful teardown that removed nothing.
 */
function assertManifestBelongs(identity: FeatureIdentity, manifest: FeatureManifest | null): void {
  if (!manifest) return;
  if (manifest.project === identity.project && manifest.issue === identity.issue && manifest.slug === identity.slug) {
    return;
  }
  throw new ValidationError({
    message: "The feature manifest belongs to a different feature.",
    action: "Delete .pithy-feature.json and re-run, or check out the branch it was written for.",
    detail: `Manifest names ${manifest.project}-f${manifest.issue}-${manifest.slug}; this feature is ${identity.project}-f${identity.issue}-${identity.slug}.`,
  });
}

/** A migrate/seed seam so provision's orchestration is testable without a live backend. */
export type BackendRunner = (args: { env: string; projectDir: string }) => Promise<void>;

// The migrate names its project for the same reason the seed below does, and one more: the stamp it
// writes is what refuses a later run from another project. A feature environment's D1 is brand new, so
// this run is the one that adopts it — skip the name here and the database stays unowned for good.
const defaultMigrate: BackendRunner = async ({ env, projectDir }) => {
  // One config load, two facts, both from the worktree's own root config: the project the brand-new D1 is
  // stamped for, and the account it is created and migrated in. A feature environment is remote by
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
// the same resolver every feature resource name already leads with.
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

/** One provisioned resource in the report: what it is, and whether this run created it or reused it. */
export interface ProvisionedResource extends FeatureResource {
  /** True when this run created the resource; false when it already existed (resumable re-run). */
  created: boolean;
}

/**
 * The structured outcome of `pithy feature provision` — the `--json` payload and the human summary source.
 *
 * **No `migrated`/`seeded` pair, for the reason `CreateReport` states (#231).** Both were literal `true`s
 * beside the two `await`s that ran the steps, and both steps throw, so the report's own existence already
 * carried the fact. A constant is not a field.
 */
export interface ProvisionReport {
  /** The command that produced the report. */
  command: "feature.provision";
  /** The environment provisioned. */
  env: string;
  /** Every resource, in provision order, flagged created vs. reused. */
  resources: ProvisionedResource[];
  /** Each Worker and the environment-scoped script name it deploys under for this feature. */
  workers: { worker: string; name: string }[];
  /** Each service binding and the feature-scoped Worker it now targets. */
  services: { binding: string; service: string }[];
}

/** Options for {@link provisionFeature}. */
export interface ProvisionFeatureOptions {
  /** The worktree root — where wrangler.jsonc and the manifest live. */
  projectDir: string;
  /** The target environment (the feature's own ephemeral env by default, or a named `--env`). */
  env: string;
  /**
   * Every capability the feature spans — the union of each Worker's own `apps/<name>/pithy.config.ts`,
   * deduped by name. It is a union rather than a per-Worker loop because a feature environment is one
   * environment: `provisionableBindings` dedupes by **binding name**, and sharing is keyed on exactly that
   * — two Workers that both declare `DB` get one database, and a Worker wanting its own declares a
   * different binding.
   */
  capabilities: Capability[];
  /** The feature identity — project/issue/slug — for the resource-naming convention. */
  identity: FeatureIdentity;
  /** The provisioners to use (default: {@link cloudflareProvisioners} over live CF clients). */
  provisioners: FeatureProvisioners;
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
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
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
  }));

/** One Worker as provisioning needs it: where it lives, and what *it* composes. */
export interface ProvisionWorker {
  /** The Worker's deploy name — its `wrangler.jsonc` `name` — which the feature script name derives from. */
  name: string;
  /** The Worker's directory — the `wrangler.jsonc` this run writes into, and the `apps/<name>` a sibling's service binding names it by. */
  dir: string;
  /** That Worker's own capabilities, from its `apps/<name>/pithy.config.ts`. */
  capabilities: Capability[];
}

/**
 * Resolve a `service` binding's target to the script name that Worker actually deploys under.
 *
 * A service binding names its target as it appears in `apps/<name>/` (`BindingSpec.service`), but a Worker
 * deploys under its `wrangler.jsonc` `name` — and the two diverge routinely (`pithy init acme` writes
 * `apps/api/wrangler.jsonc` with `"name": "acme-api"`). Feature-scoping the directory name would point the
 * binding at `<project>-f<issue>-<slug>-api` while the target deploys as `<project>-f<issue>-<slug>-acme-api`:
 * RPC through that binding hits a script nobody deploys, and provision reports success. So both sides go
 * through the resolved Worker set, which carries the deploy name, and the directory basename is only the key.
 *
 * A target that matches no Worker is refused rather than guessed: provision writes an `env.<env>` stanza only
 * for the Workers it resolved, so nothing else can be feature-scoped correctly, and a silently dangling
 * service name is the exact failure this resolution exists to remove.
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
 * Provision (or resume provisioning) a feature's Cloudflare environment. For each provisionable binding:
 * compute its name, reuse the resource if it already exists (matched by name), else create it, and record
 * its id in the per-feature manifest **after each step** so an interrupted run resumes cleanly. Then write
 * the ids into `wrangler.jsonc env.<env>` and run remote migrate + seed (both idempotent). Exits with a
 * report; safe to re-run.
 */
export async function provisionFeature(options: ProvisionFeatureOptions): Promise<ProvisionReport> {
  const audit = options.audit ?? (async () => {});
  const bindings = provisionableBindings(options.capabilities);
  // Resolve the Workers first. Their deploy names are what every service binding is retargeted at, so an
  // unresolvable target must fail here — before a single Cloudflare resource is created for the feature.
  const workers = await (options.resolveWorkers ?? defaultResolveWorkers)(options.projectDir);
  const services = serviceBindings(options.capabilities).map((service) => ({
    binding: service.binding,
    service: featureWorkerName(options.identity, resolveServiceTarget(workers, service.target)),
  }));
  const path = manifestPath(options.projectDir);
  const existing = await readManifest(path);
  assertManifestBelongs(options.identity, existing);
  let manifest: FeatureManifest = {
    ...emptyManifest({ ...options.identity, env: options.env }),
    // Carry forward only entries this feature could have created. Keeping a foreign one would re-persist it
    // under a freshly-written, legitimate-looking header — laundering it into what `destroy` later deletes.
    resources: (existing?.resources ?? []).filter((resource) => isOwnedByFeature(options.identity, resource)),
  };

  const resources: ProvisionedResource[] = [];
  for (const { binding, kind } of bindings) {
    const name = featureResourceName(options.identity, binding, kind);
    const provisioner = options.provisioners[kind];
    const found = await provisioner.find(name);
    const id = found ? found.id : (await provisioner.create(name)).id;
    const resource: FeatureResource = { kind, binding, name, id };
    manifest = upsertResource(manifest, resource);
    await writeManifest(path, manifest); // persist after each — a crash mid-run resumes from here.
    resources.push({ ...resource, created: found === null });

    // Record only a genuine creation; a resumed run that reused an existing resource changed nothing.
    if (!found) {
      await audit({
        environment: options.env,
        action: FeatureAuditActions.resourceCreated,
        outcome: "success",
        resourceType: AUDIT_RESOURCE_TYPE[kind],
        resourceId: id,
        metadata: { name, binding, feature: options.identity.slug, issue: options.identity.issue },
      });
    }
  }

  // Write the ids, the environment-scoped script name, and the service targets into **each Worker's own**
  // `wrangler.jsonc` — the file wrangler actually reads, and the file `migrate`/`seed` resolve binding ids
  // from. There is no root Worker: every Worker lives in `apps/<name>/` and owns its wrangler config.
  //
  // **A Worker receives only the bindings its own config declares.** The feature provisions one resource
  // per binding name across the whole feature (that is how two Workers share a database — same binding
  // name, same resource), but the *wiring* is per Worker: handing a Worker ids for resources it never
  // declared would put bindings in its wrangler config that it has no business holding.
  for (const worker of workers) {
    const declared = new Set(provisionableBindings(worker.capabilities).map((binding) => binding.binding));
    const owned = manifest.resources.filter((resource) => declared.has(resource.binding));
    await applyProvisionedIds(worker.dir, options.env, owned);
    await applyWorkerEnv({
      workerDir: worker.dir,
      env: options.env,
      name: featureWorkerName(options.identity, worker.name),
      // Likewise: only the service bindings this Worker declares, retargeted at the feature's copy.
      services: serviceBindings(worker.capabilities).map((service) => ({
        binding: service.binding,
        service: featureWorkerName(options.identity, resolveServiceTarget(workers, service.target)),
      })),
    });
  }

  const migrate = options.migrate ?? defaultMigrate;
  const seed = options.seed ?? defaultSeed;
  // migrate and seed fan out over the Workers themselves, each against its own wrangler.jsonc — the file
  // this run just wrote the feature's binding ids into.
  await migrate({ env: options.env, projectDir: options.projectDir });
  await seed({ env: options.env, projectDir: options.projectDir });

  return {
    command: "feature.provision",
    env: options.env,
    resources,
    workers: workers.map((worker) => ({ worker: worker.name, name: featureWorkerName(options.identity, worker.name) })),
    services,
  };
}

/** One deleted resource in the teardown report. */
export interface DeprovisionedResource {
  /** The resource kind. */
  kind: FeatureResourceKind;
  /** The resource name. */
  name: string;
  /** The resource id that was deleted. */
  id: string;
}

/** The structured outcome of the remote half of `pithy feature destroy`. */
export interface DeprovisionReport {
  /** Every resource deleted — from the manifest and from the expected-name reconcile. */
  deleted: DeprovisionedResource[];
}

/** Options for {@link deprovisionFeature}. */
export interface DeprovisionFeatureOptions {
  /** The worktree root — where the manifest lives. */
  projectDir: string;
  /** The feature identity — project/issue/slug — for recomputing expected resource names. */
  identity: FeatureIdentity;
  /**
   * Every capability the feature spans (the union of its Workers'), whose bindings define the exact set of
   * names this feature could have created — the same union `provision` named them from.
   */
  capabilities: Capability[];
  /** The environment being torn down — recorded on each audit event, since the trail lands elsewhere. */
  env: string;
  /** The provisioners to delete through. */
  provisioners: FeatureProvisioners;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}

/**
 * Delete a feature's Cloudflare resources: first the exact ids recorded in the manifest, then reconcile —
 * for every binding the enabled capabilities declare, recompute the exact resource name (the same function
 * `provision` named it with) and delete it if it still exists. This catches a partial-failed `provision`
 * (a resource created in the tiny window before the manifest recorded it) without a prefix scan — an exact
 * name can never collide with a sibling feature whose slug is a hyphen-prefix of this one's, which a
 * `startsWith` scan would. Idempotent: every delete tolerates an already-gone resource, and a missing
 * manifest is fine, so it exits 0 even when there is nothing left to remove. Removes the manifest file last.
 */
export async function deprovisionFeature(options: DeprovisionFeatureOptions): Promise<DeprovisionReport> {
  const path = manifestPath(options.projectDir);
  const manifest = await readManifest(path);
  const deleted: DeprovisionedResource[] = [];
  const seen = new Set<string>(); // `${kind}:${id}` — never delete the same resource twice.

  const audit = options.audit ?? (async () => {});
  const remove = async (kind: FeatureResourceKind, name: string, id: string): Promise<void> => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    await options.provisioners[kind].delete(id);
    seen.add(key);
    deleted.push({ kind, name, id });
    // `warning`, not `info`: this destroys real infrastructure, and in CI no human saw it happen.
    await audit({
      environment: options.env,
      action: FeatureAuditActions.resourceDeleted,
      outcome: "success",
      severity: "warning",
      resourceType: AUDIT_RESOURCE_TYPE[kind],
      resourceId: id,
      metadata: { name, feature: options.identity.slug, issue: options.identity.issue },
    });
  };

  assertManifestBelongs(options.identity, manifest);
  for (const resource of manifest?.resources ?? []) {
    // Only delete what this feature could have named. An entry pointing anywhere else is not ours to
    // remove — the reconcile pass below re-derives every real name from the identity anyway, so nothing
    // legitimate is lost by distrusting the file.
    if (isOwnedByFeature(options.identity, resource)) await remove(resource.kind, resource.name, resource.id);
  }

  // Reconcile by exact expected name — a resource `provision` may have created but not yet recorded.
  for (const { binding, kind } of provisionableBindings(options.capabilities)) {
    const name = featureResourceName(options.identity, binding, kind);
    const found = await options.provisioners[kind].find(name);
    if (found) await remove(kind, name, found.id);
  }

  await rm(path, { force: true });
  return { deleted };
}
