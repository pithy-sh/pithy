// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { rm } from "node:fs/promises";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import {
  canonicalIssue,
  type FeatureIdentity,
  type FeatureResourceKind,
  featureResourceName,
} from "@pithy-sh/core/src/naming/feature";
import { featureScope, featureWorkerScriptNames } from "@pithy-sh/core/src/naming/provisionScope";
import type { SecretDispatcher, SecretProbe } from "@pithy-sh/secrets/src/cli/dispatch";
import { partialWriteReport } from "@pithy-sh/secrets/src/cli/partialWrite";
import { masterKeySecretName, type SecretsProvisioner } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import type { CliAuditEmit } from "../audit/cliAudit";
import { managerMintedSecrets, mintDeclaredSecrets, storeSecretMinter } from "../capabilities/mintSecrets";
import { type KitDeployReport, summarizeKitDeploy } from "../project/deployKit";
import {
  type BackendRunner,
  defaultResolveWorkers,
  type ProvisionProgress,
  type ProvisionReport,
  type ProvisionWorker,
  provisionEnvironment,
  provisionWorkerNames,
} from "../provision/environment";
import {
  AUDIT_RESOURCE_TYPE,
  type FeatureIndexes,
  ProvisionAuditActions,
  type ResourceProvisioners,
  type TeardownKind,
  type WorkerScripts,
  type WorkflowDefinitions,
} from "../provision/resources";
import { secretsStoreBindings, workerSecretRegistry } from "../provision/secretBindings";
import type { SecretsStore } from "../provision/store";
import { bindFeatureHosts } from "../provision/wranglerEnv";
import { provisionableBindings } from "./bindings";
import {
  assertNoFeatureHostCollision,
  featureHostCapabilities,
  featureHostScripts,
  featureIndexesFor,
  hostedWorkflowEntries,
} from "./hosts";
import {
  emptyManifest,
  type FeatureManifest,
  type FeatureResource,
  type FeatureScript,
  manifestPath,
  readManifest,
  writeManifest,
} from "./manifest";
import {
  allocateFeatureRatelimits,
  assertNoDeclaredFeatureIds,
  featureRatelimitClaims,
  readWorkerRatelimits,
} from "./ratelimits";

/**
 * `pithy provision --feature` — one branch's ephemeral Cloudflare environment.
 *
 * The work is `provisionEnvironment`'s, unchanged for every environment a project has. What is a
 * feature's own, and lives here, is the two things a *deployed* environment has no equivalent of: the
 * branch-derived naming ({@link featureScope}, with no environment segment because a feature *is* an
 * environment), and the manifest that lets `destroy` delete exactly what was created and nothing else.
 *
 * `destroy` reverses it: delete the manifest's Worker scripts and resources, then reconcile by recomputing
 * each expected name, so a partial-failed provision — or a feature provisioned before scripts were
 * recorded (#592) — still loses everything named for it. Not a `<script>-feature` Worker such a feature may
 * also have deployed: that name carries no feature identity, and every branch shared it.
 */

/**
 * Whether a manifest entry is one **this** feature could have created.
 *
 * The manifest is a file in the worktree, so it is repository content, not a trusted record: a branch can
 * carry a crafted `.pithy-feature.json` (git-ignored stops an accidental commit, not `git add -f`, and does
 * nothing for an already-tracked file on a fetched branch). Deleting an id straight out of it would make the
 * file an unauthenticated "delete this resource" instruction — and `destroy` runs headlessly in CI, with a
 * live token, against a branch that may have come from anyone.
 *
 * So an entry is honored only when its recorded name is exactly the name `provision` would have generated
 * for that binding and kind under this identity. The check needs nothing from the file but the entry's own
 * `binding`/`kind`, so a legitimate record still validates even after its capability is removed from config.
 */
function isOwnedByFeature(identity: FeatureIdentity, resource: FeatureResource): boolean {
  return resource.name === featureResourceName(identity, resource.binding, resource.kind);
}

/**
 * The same rule for a recorded Worker script (#592): honored only when its name is one this feature could
 * have deployed that Worker under, recomputed from the entry's own two names. An entry naming
 * `acme-prod-api` beside `app: "api"` is a crafted instruction to delete production, and is ignored.
 */
function isScriptOwnedByFeature(identity: FeatureIdentity, script: FeatureScript): boolean {
  return featureWorkerScriptNames(identity, script).includes(script.name);
}

/**
 * Reject a manifest whose header names a different feature. The per-entry name check below is the real
 * control, but a mismatched header means the file was authored for something else entirely — failing loudly
 * beats silently ignoring every entry, which would look like a successful teardown that removed nothing.
 */
function assertManifestBelongs(identity: FeatureIdentity, manifest: FeatureManifest | null): void {
  if (!manifest) return;
  if (
    manifest.project === identity.project &&
    canonicalIssue(manifest.issue) === canonicalIssue(identity.issue) &&
    manifest.slug === identity.slug
  ) {
    return;
  }
  throw new ValidationError({
    message: "The feature manifest belongs to a different feature.",
    action: "Delete .pithy-feature.json and re-run, or check out the branch it was written for.",
    detail: `Manifest names ${manifest.project}-f${manifest.issue}-${manifest.slug}; this feature is ${identity.project}-f${identity.issue}-${identity.slug}.`,
  });
}

/** Options for {@link provisionFeature}. */
export interface ProvisionFeatureOptions {
  /** The worktree root — where `apps/` and the manifest live. */
  projectDir: string;
  /** Every capability the feature spans — the union of its Workers' own configs. */
  capabilities: Capability[];
  /** The feature identity — project/issue/slug — for the resource-naming convention. */
  identity: FeatureIdentity;
  /** The provisioners to use (`cloudflareProvisioners` over live CF clients in a real run). */
  provisioners: ResourceProvisioners;
  /**
   * Whether the project declares that it administers itself — forwarded verbatim, and required here for
   * the reason it is required one layer down: it is the root config's sentence, and only the caller that
   * loaded that file has read it.
   *
   * **A feature environment is where this matters most.** Its stanza is generated on every run, so an
   * entry added by hand does not survive the next `pithy provision --feature`, and its script name is
   * composed from the branch rather than typed.
   */
  administersItself: boolean;
  /** Migration runner seam (default: `migrateProject`). */
  migrate?: BackendRunner;
  /** Seed runner seam (default: `seedProject`). */
  seed?: BackendRunner;
  /**
   * Look up the account's `workers.dev` subdomain (`accountWorkersSubdomain` in a real run). A feature Worker
   * answers on `https://<script>.<subdomain>.workers.dev`, and this is how its stanza is stamped with that
   * address (#643). Omitted, no address is stamped and the feature resolves to the local placeholder.
   */
  workersSubdomain?: () => Promise<string | null>;
  /** Worker-resolution seam (default: the real `apps/` resolver), so tests fix the worker set. */
  resolveWorkers?: (projectDir: string) => Promise<ProvisionWorker[]>;
  /** Where each step is narrated as it happens. Forwarded verbatim; omitted means a silent run (#515). */
  onProgress?: ProvisionProgress;
  /**
   * The account's Secrets Store, when one is reachable. Given it, the feature's Workers get their
   * `secrets_store_secrets` stanza, and every mintable store secret is created in the feature's own entry. Without
   * it the feature is provisioned exactly as it was before, and the omission is visible in the report.
   */
  store?: SecretsStore;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
  /**
   * **The feature's master key, created by the CLI with its own credentials (#643)** — `CloudflareSecretsProvisioner`
   * handed this feature, in a real run, creating the feature's own key entry only if absent. Called only when the
   * feature composes the secrets capability, and before anything binds the key. The feature's `SECRETS` database and
   * its migration are the generic provisioning's; its manager is one of the kit hosts {@link deployHosts} deploys.
   *
   * **No token.** A feature's manager holds no Cloudflare API token and rotates nothing, so branch code never holds
   * write access to the account's one Secrets Store, where production's master key lives. Nothing here mints one.
   */
  secrets?: Pick<SecretsProvisioner, "ensureMasterKey">;
  /**
   * **The feature's own secrets manager, as a dispatcher (#643)** — `WorkflowSecretDispatcher` bound to this
   * feature, in a real run. Once the manager is deployed, every mintable `d1` secret is created through it by
   * `mintDeclaredSecrets`, exactly as `pithy secrets provision` creates a declared environment's: probed first,
   * written with `create`, never over a value that is there. Omitted, the `d1` secrets stay pending.
   */
  managers?: SecretDispatcher & SecretProbe;
  /**
   * **The indexes a feature creates for its hosts (#643)** — `CloudflareVectorProvisioner`'s own `ensureIndex`
   * and `ensureMetadataIndexes`, in a real run. Omitted, none are created and no app Worker is bound to one.
   */
  indexes?: FeatureIndexes;
  /**
   * **Stand up every kit host the feature composes (#643)** — `deployKitWorkers` handed this feature, in a real
   * run: the resolver and the gated deploy a declared environment's hosts go through. Called once the feature's
   * configs are written and migrated. Omitted, no host is deployed and no app Worker is bound to one.
   */
  deployHosts?: () => Promise<KitDeployReport>;
}

/**
 * Provision (or resume provisioning) a feature's Cloudflare environment, recording every resource in the
 * per-feature manifest **after each step** so an interrupted run resumes cleanly and `destroy` knows
 * exactly what to remove. Idempotent; safe to re-run.
 *
 * **There is no `env` argument, and that is the fix rather than an omission.** With the environment as a
 * separate parameter, `<project>-f<issue>-<slug>-db` could be composed and written into the `staging`
 * stanza of a checked-in `wrangler.jsonc`, then migrated against. The scope carries both halves, so the
 * combination cannot be expressed. A declared environment is `pithy provision --env`'s job.
 *
 * **The report carries no `command` of its own** (#251). The command's name belongs to the command:
 * `pithy provision` stamps `"provision"` on what it prints, and a second name stamped here would be a
 * caller's own field silently overwritten by a spread.
 */
export async function provisionFeature(options: ProvisionFeatureOptions): Promise<ProvisionReport> {
  const path = manifestPath(options.projectDir);
  const scope = featureScope(options.identity);
  // Resolved once, here, so the collision refusal below and the run itself read one Worker set.
  const workers = await (options.resolveWorkers
    ? options.resolveWorkers(options.projectDir)
    : defaultResolveWorkers(options.projectDir, scope.stanza));
  // Before anything is created: an app Worker that would deploy under a kit host's name (F3 of #643's review).
  assertNoFeatureHostCollision(options.identity, workers.map(provisionWorkerNames));

  // **The feature's own rate-limit namespaces, allocated before any stanza is written (#643).** Every Worker's
  // tracked config is read, so a declared id in the feature range is refused wherever it is, and each limiter
  // the feature binds gets an id no other feature, environment or project holds — see `./ratelimits`.
  const store = options.store;
  const ratelimits = await Promise.all(workers.map(readWorkerRatelimits));
  assertNoDeclaredFeatureIds(ratelimits);
  const limiters = ratelimits.flatMap((worker) => worker.limiters);
  let ratelimitIds: Map<string, string> | undefined;
  if (limiters.length > 0) {
    const list = store?.list?.bind(store);
    if (!store || !list) {
      throw new ValidationError({
        message: "This feature binds rate limiters, and each takes a namespace of its own from the Secrets Store.",
        action: "Set SECRETS_STORE_ID and the Cloudflare credentials, then run pithy provision --feature again.",
        detail: `feature ${options.identity.project}-f${options.identity.issue}-${options.identity.slug}: ${limiters.length} limiter(s), no store to allocate from`,
      });
    }
    ratelimitIds = await allocateFeatureRatelimits({
      identity: options.identity,
      limiters,
      declared: new Set(ratelimits.flatMap((worker) => worker.declared.map((entry) => entry.id))),
      store: { list, create: (name, value) => store.create(name, value), remove: (name) => store.remove(name) },
    });
  }

  // **The feature's master key, the one secret the CLI writes into the account for it (#643).** A feature has its
  // own `SECRETS` database and its own manager, and the manager seals every `d1` secret under whatever key the
  // store holds, once deployed. So the key is created only if absent, and a run that fails anywhere after it
  // exists is finished by the next one: there is no "the run that created the key" for correctness to hang on.
  // No token is minted: a feature's manager holds none.
  //
  // Before `provisionEnvironment`, because its secret bindings bind the key only once it exists.
  const registry = workerSecretRegistry(options.capabilities);
  const composesSecrets = featureHostCapabilities(options.capabilities).includes("secrets");
  if (store && options.secrets && composesSecrets) {
    await options.secrets.ensureMasterKey(FEATURE_ENVIRONMENT);
  }

  const report = await provisionEnvironment({
    projectDir: options.projectDir,
    scope,
    capabilities: options.capabilities,
    provisioners: options.provisioners,
    // A feature environment is created empty; without fixtures there is nothing in it to check.
    seedData: true,
    administersItself: options.administersItself,
    record: {
      load: async () => {
        const existing = await readManifest(path);
        assertManifestBelongs(options.identity, existing);
        // Carry forward only entries this feature could have created. Keeping a foreign one would
        // re-persist it under a freshly-written, legitimate-looking header — laundering it into what
        // `destroy` later deletes.
        return {
          resources: (existing?.resources ?? []).filter((resource) => isOwnedByFeature(options.identity, resource)),
          scripts: (existing?.scripts ?? []).filter((script) => isScriptOwnedByFeature(options.identity, script)),
        };
      },
      save: async ({ resources, scripts }) => {
        const manifest: FeatureManifest = {
          ...emptyManifest({ ...options.identity, env: FEATURE_ENVIRONMENT }),
          resources,
          scripts,
        };
        await writeManifest(path, manifest);
      },
    },
    ...(options.migrate !== undefined ? { migrate: options.migrate } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.workersSubdomain !== undefined ? { workersSubdomain: options.workersSubdomain } : {}),
    ...(ratelimitIds !== undefined ? { ratelimitIds } : {}),
    resolveWorkers: async () => workers,
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    ...(store
      ? {
          secretBindings: async (capabilities) =>
            secretsStoreBindings({
              // A Worker composing no secrets capability declares no secrets, and gets no stanza.
              registry: workerSecretRegistry(capabilities) ?? {},
              scope,
              storeId: store.storeId,
              exists: (name) => store.exists(name),
              // **What makes `pithy feature` true (#321).** Every secret the registry declares mintable is created
              // here, in the branch's own entry, so nothing is shared with a declared environment.
              //
              // Through the store's create-if-absent (#643): absence is checked first, and a run that loses a race
              // for the same entry leaves the winner's value where it is rather than writing over it.
              mint: storeSecretMinter({
                store: { put: async (name, value) => void (await store.create(name, value)) },
                environment: scope.stanza,
                ...(options.audit !== undefined ? { audit: options.audit } : {}),
              }),
            }),
        }
      : {}),
    ...(options.audit !== undefined ? { audit: options.audit } : {}),
    // Which feature, on every creation event. `provisionEnvironment` knows the names it wrote; only
    // this caller knows the branch they came from, and that is what an operator reads the trail for.
    auditMetadata: { feature: options.identity.slug, issue: options.identity.issue },
  });
  if (!options.deployHosts) return report;

  // **The indexes the hosts bind that the generic provisioning has no kind for (#643)** — a vector host's
  // Vectorize indexes, named for the feature and created with their declared shape, each only if absent. Before
  // the hosts deploy, because a deploy binding an index that does not exist is refused.
  if (options.indexes) {
    for (const index of await featureIndexesFor(options.capabilities, options.projectDir, options.identity)) {
      await options.indexes.ensure(index);
    }
  }

  // After the configs and the schema: a host deployed before them binds ids nothing wrote yet.
  const hosts = await options.deployHosts();

  // **Bind each app Worker to the hosts that deployed, and to no other (F2).** Written after the deploy, so a
  // host that failed leaves no binding to it for the next `pithy deploy --env feature` to ship.
  const deployed = new Set(
    hosts.workers
      .filter((row) => row.outcome === "deployed" || row.outcome === "unchanged")
      .map((row) => row.capability),
  );
  for (const worker of workers) {
    const hosted = hostedWorkflowEntries(worker.capabilities, scope);
    await bindFeatureHosts({
      workerDir: worker.dir,
      hosted,
      bound: hosted.filter((entry) => deployed.has(entry.capability)),
      // The feature's own indexes this Worker's capabilities bind — created above, before any host bound them.
      indexes: options.indexes
        ? await featureIndexesFor(worker.capabilities, options.projectDir, options.identity)
        : [],
    });
  }

  // Every composed host, deployed or unchanged — a skip is as fatal as a failure here, because each one is a
  // Worker the feature's app dispatches into, and a missing row is a host the pass never reached.
  const expected = featureHostCapabilities(options.capabilities);
  const reasons = [
    ...hosts.problems,
    ...hosts.workers.filter((row) => !deployed.has(row.capability)).map(summarizeKitDeploy),
    ...expected
      .filter((capability) => !hosts.workers.some((row) => row.capability === capability))
      .map((capability) => `${capability}: not deployed. Nothing composed it where the kit pass looked.`),
  ];
  if (reasons.length > 0) {
    throw new ValidationError({
      message: "Not every kit Worker this feature composes deployed, so the feature cannot run.",
      action: `${reasons.join(" ")} Fix it, then run pithy provision --feature again.`,
      detail: `feature ${options.identity.project}-f${options.identity.issue}-${options.identity.slug}: ${reasons.join("; ")}`,
    });
  }

  // **The feature's `d1` secrets, created by its own manager (#643)** — `mintDeclaredSecrets`, the pass
  // `pithy secrets provision` runs, against the manager just deployed. It probes before it mints and writes
  // with `create`, so a secret that is there is never overwritten, a probe that fails is a failed run rather than
  // an absence, and a re-run after any failure creates exactly what is still missing.
  const featureSecrets =
    options.managers && registry && managerMintedSecrets(registry).length > 0
      ? await mintDeclaredSecrets({
          registry,
          dispatcher: options.managers,
          probe: options.managers,
          environments: [FEATURE_ENVIRONMENT],
          ...(options.audit !== undefined ? { audit: options.audit } : {}),
        })
      : undefined;
  return { ...report, hosts: hosts.workers, ...(featureSecrets ? { featureSecrets } : {}) };
}

/** One deleted resource in the teardown report — a Cloudflare resource, or a Worker script. */
export interface DeprovisionedResource {
  /** The resource kind. `worker` for a Worker script (#592). */
  kind: TeardownKind;
  /** The resource name. */
  name: string;
  /** The resource id that was deleted. A Worker script's is its name, which is all Cloudflare addresses it by. */
  id: string;
}

/** The structured outcome of the remote half of `pithy feature destroy`. */
export interface DeprovisionReport {
  /** Every resource deleted — from the manifest and from the expected-name reconcile. */
  deleted: DeprovisionedResource[];
}

/** A carried value arrives as `unknown`; this is the narrowing, never a cast. */
function isDeletedList(value: unknown): value is DeprovisionedResource[] {
  return Array.isArray(value);
}

/**
 * **Where the record of a partial teardown rides out of a failure (#380).**
 *
 * A teardown deletes real infrastructure one resource at a time and has no transaction across them. The
 * fourth delete throws, three databases are already gone, and the return value that would have named
 * them never happens — so the operator is told the teardown failed and nothing about what it destroyed.
 * That is the report `pithy feature destroy` exists to produce, and it was the one the throw took.
 *
 * The mechanism is `partialWriteReport`'s, the same one `mintDeclaredSecrets` carries its minted secrets
 * on (#324). Carried, never replaced: the failure the operator reads is the failure that happened.
 */
const deprovisionReport = partialWriteReport<DeprovisionedResource[]>("pithy.cli.deprovisionReport", isDeletedList);

/**
 * What a failed {@link deprovisionFeature} run deleted before it failed, in deletion order. Empty when
 * the thrown thing carries no report — which is the honest answer for a throw from anywhere else.
 */
export function deletedBeforeFailure(error: unknown): DeprovisionedResource[] {
  return deprovisionReport.read(error) ?? [];
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
  provisioners: ResourceProvisioners;
  /**
   * The account's Worker scripts (#592). Required beside `provisioners` rather than optional: a teardown
   * that could run without it is the teardown that left every feature's Workers deployed.
   */
  scripts: WorkerScripts;
  /**
   * The account's Workflow definitions (#643). Required for the same reason: every kit host a feature deploys
   * hosts Workflows, and Cloudflare does not say that deleting the script deletes them.
   */
  workflows: WorkflowDefinitions;
  /**
   * The feature's own indexes (#643), recomputed from what the branch composes and deleted by name. Omitted when
   * no account is reachable for them.
   */
  indexes?: FeatureIndexes;
  /**
   * The project's Workers, as the branch has them now — each one's two names are what the scripts a
   * feature deployed before scripts were recorded are recomputed from. Empty when they cannot be known;
   * the manifest's own record still runs.
   */
  workers: readonly Pick<ProvisionWorker, "name" | "dir">[];
  /**
   * The account's Secrets Store, when one is reachable. Teardown removes every entry this feature could
   * have created — and only those. An entry left behind is a live credential in a flat, account-wide
   * namespace with nothing pointing at it.
   */
  store?: SecretsStore;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
}

/**
 * Delete a feature's Workflows, its Worker scripts, then its Cloudflare resources and store entries.
 *
 * **Every kit host too (#643)**, by the name each registry host takes for this feature, and **every Workflow
 * those scripts host, explicitly and first** — Cloudflare does not document that deleting a script deletes its
 * Workflows, so teardown does not rely on it.
 *
 * **Scripts before resources (#592).** A script deployed against a database that is already gone answers on
 * workers.dev and fails on its first binding read; deleting it before its resources means there is never
 * a moment a reachable Worker is bound to nothing. Each script is the manifest's record, then every name
 * the current Workers could have deployed under — both shapes, see `featureWorkerScriptNames` — and each
 * is deleted only once the account confirms it is there, because a named script may never have deployed.
 * Each delete is forced, because a feature's Workers bind each other and Cloudflare refuses to delete a
 * callee its caller still binds: `web` calling `api` sorts the callee first, and teardown never finished.
 *
 * Resources: first the exact ids recorded in the manifest, then reconcile —
 * for every binding the enabled capabilities declare, recompute the exact resource name (the same function
 * `provision` named it with) and delete it if it still exists. This catches a partial-failed `provision`
 * (a resource created in the tiny window before the manifest recorded it) without a prefix scan — an exact
 * name can never collide with a sibling feature whose slug is a hyphen-prefix of this one's, which a
 * `startsWith` scan would. Idempotent: every delete tolerates an already-gone resource, and a missing
 * manifest is fine, so it exits 0 even when there is nothing left to remove. Removes the manifest file last.
 *
 * **There is no deployed-environment counterpart, deliberately.** `pithy provision --env prod` creates; no
 * command deletes. A staging or production database is not a build artifact, and the one-word difference
 * between tearing down a branch and tearing down production is not a difference a flag should carry.
 */
export async function deprovisionFeature(options: DeprovisionFeatureOptions): Promise<DeprovisionReport> {
  const path = manifestPath(options.projectDir);
  const manifest = await readManifest(path);
  const deleted: DeprovisionedResource[] = [];
  const seen = new Set<string>(); // `${kind}:${id}` — never delete the same resource twice.

  const audit = options.audit ?? (async () => {});
  const record = async (kind: TeardownKind, name: string, id: string): Promise<void> => {
    deleted.push({ kind, name, id });
    // `warning`, not `info`: this destroys real infrastructure, and in CI no human saw it happen.
    await audit({
      environment: options.env,
      action: ProvisionAuditActions.resourceDeleted,
      outcome: "success",
      severity: "warning",
      resourceType: AUDIT_RESOURCE_TYPE[kind],
      resourceId: id,
      metadata: { name, feature: options.identity.slug, issue: options.identity.issue },
    });
  };
  const remove = async (kind: FeatureResourceKind, name: string, id: string): Promise<void> => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    await options.provisioners[kind].delete(id);
    seen.add(key);
    await record(kind, name, id);
  };
  const removeScript = async (name: string): Promise<void> => {
    const key = `worker:${name}`;
    if (seen.has(key)) return;
    // Seen once asked, deployed or not: a name the account just said is absent is not asked about twice.
    seen.add(key);
    if (!(await options.scripts.exists(name))) return;
    await options.scripts.delete(name);
    await record("worker", name, name);
  };

  // Everything from here destroys infrastructure, and `deleted` grows one resource at a time. A throw
  // anywhere inside used to take the whole list with it — the resources were gone and the record of
  // which ones was not, on the command whose entire output is that record (#380). It is carried on the
  // failure instead, and the failure itself is rethrown untouched: teardown still stops, because a
  // delete that failed for a reason belonging to the account — a revoked token, a resource another
  // project holds — is not a reason to keep deleting.
  try {
    assertManifestBelongs(options.identity, manifest);
    // Every script this feature could have deployed, named before anything is deleted: the manifest's record;
    // every name the current Workers could have deployed under — a feature provisioned before scripts were
    // recorded has none in its manifest, and one deployed before #587 runs under the doubled shape; and every
    // kit host this feature could have stood up (#643), whatever the branch composes now — a host deployed
    // before its capability left the branch is still the feature's, and an exact name reaches nobody else's.
    const scripts = new Set<string>();
    for (const script of manifest?.scripts ?? []) {
      if (isScriptOwnedByFeature(options.identity, script)) scripts.add(script.name);
    }
    for (const worker of options.workers) {
      for (const name of featureWorkerScriptNames(options.identity, provisionWorkerNames(worker))) scripts.add(name);
    }
    for (const host of featureHostScripts(options.identity)) scripts.add(host.script);

    // **Their Workflows first, by name, before the scripts that host them (#643).** Cloudflare documents that
    // deleting a Workflow leaves its script alone, and says nothing of the reverse, so teardown does not rely on
    // a script taking its Workflows with it. Found by exact hosting-script name, so nothing else's is reached.
    for (const workflow of await options.workflows.hostedBy(scripts)) {
      await options.workflows.delete(workflow);
      await record("workflow", workflow, workflow);
    }
    for (const name of scripts) await removeScript(name);

    // The feature's own indexes, by the names its hosts' `featureIndexes` compose — after the scripts that bind them.
    if (options.indexes) {
      for (const index of await featureIndexesFor(options.capabilities, options.projectDir, options.identity)) {
        if (await options.indexes.remove(index.name)) await record("vectorize", index.name, index.name);
      }
    }

    for (const resource of manifest?.resources ?? []) {
      // Only delete what this feature could have named. An entry pointing anywhere else is not ours to
      // remove — the reconcile pass below re-derives every real name from the identity anyway, so nothing
      // legitimate is lost by distrusting the file.
      if (isOwnedByFeature(options.identity, resource)) await remove(resource.kind, resource.name, resource.id);
    }

    // Reconcile by exact expected name — a resource `provision` may have created but not yet recorded.
    //
    // **Deliberately unfiltered by `declinedBindings`.** Every other reader of this function skips a
    // declined binding, and this one must not: a decline stops a resource being *created*, and says
    // nothing about one created before the decline was written. Filtering here would leave exactly those
    // resources behind — a teardown that exits 0 having orphaned the thing it was run to remove, which is
    // the worst failure a cleanup path has. Teardown scans the whole declared set, always.
    for (const { binding, kind } of provisionableBindings(options.capabilities)) {
      const name = featureResourceName(options.identity, binding, kind);
      const found = await options.provisioners[kind].find(name);
      if (found) await remove(kind, name, found.id);
    }

    // The feature's own store entries, by recomputed name — the same rule the resources above follow, and
    // the same reason: an exact name is the only thing that cannot reach a sibling's or an environment's.
    // Every one is the feature's own since #643, a `global` secret's included: `featureScope` names a feature's
    // entry for it, so removing that entry cannot touch the project's value.
    if (options.store) {
      const scope = featureScope(options.identity);
      // The union, as provisioning bound it — never capability by capability, which asked each one alone whether
      // it composed the secrets capability and so found email's link-signing key in no registry at all (#643).
      const registry: SecretRegistry = workerSecretRegistry(options.capabilities) ?? {};
      for (const [binding, entry] of Object.entries(registry)) {
        if (entry.backend !== "cf-secrets-store" || entry.keyed) continue;
        // `global` included: a feature's entry for a global secret is its own too (#643).
        await options.store.remove(scope.secretEntry(binding, entry.scope));
      }
      // The feature's master key, which no Worker's registry declares: the manager binds it (#643).
      await options.store.remove(masterKeySecretName(options.identity.project, FEATURE_ENVIRONMENT, options.identity));
      // Its rate-limit claims, found by parsing every entry, so an id this branch held is free again (#643).
      if (options.store.list) {
        for (const claim of await featureRatelimitClaims(options.identity, {
          list: options.store.list.bind(options.store),
        })) {
          await options.store.remove(claim);
        }
      }
    }
    // Nothing to revoke: a feature's manager holds no Cloudflare API token (#643).
  } catch (error) {
    // Carried, never replaced. `deleted` is what this run destroyed, by kind, name and id — the three
    // facts an operator needs to finish the teardown by hand. Nothing from the throw is copied into it.
    throw deprovisionReport.carry(error, deleted);
  }

  // The manifest is removed only on a clean pass. It is the record of what is left to delete, and a
  // teardown that failed partway is precisely when a re-run needs it.
  await rm(path, { force: true });
  return { deleted };
}
