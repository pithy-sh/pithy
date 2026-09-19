// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { rm } from "node:fs/promises";
import type { D1Database } from "@cloudflare/workers-types";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { type FeatureIdentity, type FeatureResourceKind, featureResourceName } from "@pithy-sh/core/src/naming/feature";
import { featureScope, featureWorkerScriptNames } from "@pithy-sh/core/src/naming/provisionScope";
import { partialWriteReport } from "@pithy-sh/secrets/src/cli/partialWrite";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/masterKeyBinding";
import { initialMasterKeyConfig } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import type { CliAuditEmit } from "../audit/cliAudit";
import { storeSecretMinter } from "../capabilities/mintSecrets";
import { SECRETS_D1_BINDING } from "../devSecrets/store";
import type { StatePathOptions } from "../notifier/state";
import {
  type BackendRunner,
  defaultMigrate,
  type ProvisionProgress,
  type ProvisionReport,
  type ProvisionWorker,
  provisionEnvironment,
  provisionWorkerNames,
} from "../provision/environment";
import {
  AUDIT_RESOURCE_TYPE,
  ProvisionAuditActions,
  type ResourceProvisioners,
  type TeardownKind,
  type WorkerScripts,
} from "../provision/resources";
import { secretsStoreBindings, workerSecretRegistry } from "../provision/secretBindings";
import type { SecretsStore } from "../provision/store";
import { provisionableBindings } from "./bindings";
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
  forgetFeatureSecrets,
  type KeptFeatureSecrets,
  keepFeatureSecrets,
  keptPayload,
  keptSecretNames,
  type SealedFeatureSecrets,
  sealFeatureSecrets,
} from "./secrets";

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
  if (manifest.project === identity.project && manifest.issue === identity.issue && manifest.slug === identity.slug) {
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
   * The account's Secrets Store, when one is reachable. Given it, the feature gets its **own** master
   * key and its Workers get their `secrets_store_secrets` stanza; without it the feature is provisioned
   * exactly as it was before, and the omission is visible in the report rather than silent.
   */
  store?: SecretsStore;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
  /**
   * The feature's `SECRETS` database, by id — the REST-backed D1 in a real run (#643). It is where every kept
   * `d1` secret is sealed, because that database is what the deployed Worker reads them from. Omitted, nothing
   * is sealed and the `d1` secrets stay pending, as they were before a feature kept any.
   */
  secretsDatabase?: (databaseId: string) => D1Database;
  /** Where the config directory is — the kept secrets file's home. Defaults to the real one; tests pass their own. */
  paths?: StatePathOptions;
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

  // The feature's own master key, before anything binds it (#239).
  //
  // **Its own, not the project's, and that is the decision this issue asked to be argued rather than
  // typed.** `deprovisionSecrets` preserves a key unless explicitly asked, because losing it orphans
  // every secret encrypted under it. For an ephemeral environment that reasoning inverts: nothing
  // outlives the feature, so the key is the feature's and goes with it at teardown.
  //
  // **And `ManagedEnvironment` does not widen to include it.** Since #241 that type is *the set the
  // project declared*, and everything iterating it multiplies with it — most of all a manager Worker
  // with its own D1 and its own rotation cron, per environment. A branch does not want one, and
  // `pithy secrets provision` must not deploy one per open pull request. So the feature takes the
  // narrow route: a key of its own and the bindings that reach it, and none of the durable machinery.
  // The consequence is stated where an operator meets it — a feature has no manager, so
  // `pithy secrets create` targets a declared environment, never a branch.
  const store = options.store;
  // **The feature's own secrets, generated once and kept (#643)**, before a single one is sent anywhere. See
  // `./secrets.ts` for where they live and why. Only with a store to hold the master key: without one no `d1`
  // secret can be sealed, and the run says so as it always did.
  const registry = workerSecretRegistry(options.capabilities);
  const kept: KeptFeatureSecrets | null =
    store && registry
      ? await keepFeatureSecrets({
          registry,
          identity: options.identity,
          ...(options.paths !== undefined ? { paths: options.paths } : {}),
        })
      : null;
  const regenerated = new Set<string>();
  const audit = options.audit ?? (async () => {});
  if (store && kept && registry) {
    for (const name of keptSecretNames(registry)) {
      const entry = registry[name];
      const payload = keptPayload(kept, registry, name);
      if (entry?.backend !== "cf-secrets-store" || !payload) continue;
      const secretName = scope.secretEntry(name, "environment");
      const present = await store.exists(secretName);
      if (!present && name === MASTER_KEY_BINDING) {
        // The master key is written here; every other absent entry is minted by the binding pass below, from
        // the same kept value, so its report line still says the run created it.
        await store.put(secretName, payload.text);
      } else if (present && kept.generated.includes(name)) {
        // The deployment holds a value this machine never kept. Replaced, so the store and the kept copy agree —
        // and reported, because everything signed with the old value stops verifying.
        await store.put(secretName, payload.text);
        regenerated.add(name);
        await audit({
          environment: scope.stanza,
          action: "secrets/set",
          outcome: "success",
          severity: "warning",
          resourceType: "secret",
          resourceId: secretName,
          metadata: { name: secretName, kind: "regenerated", feature: options.identity.slug },
        });
      }
    }
  } else if (store) {
    const masterKey = scope.secretEntry(MASTER_KEY_BINDING, "environment");
    if (!(await store.exists(masterKey))) {
      await store.put(masterKey, JSON.stringify(await initialMasterKeyConfig()));
    }
  }

  // Sealed straight after the schema lands and before the seed, so a fixture that fails still leaves a
  // deployment that signs people in. Idempotent: a row already holding the kept value is left alone.
  let sealed: SealedFeatureSecrets | null = null;
  const migrate = options.migrate ?? defaultMigrate;
  const migrateAndSeal: BackendRunner = async (args) => {
    await migrate(args);
    if (!kept || !registry || !options.secretsDatabase) return;
    const databaseId = await featureSecretsDatabaseId(path, options.identity);
    if (databaseId === null) return;
    sealed = await sealFeatureSecrets({ kept, registry, database: options.secretsDatabase(databaseId) });
  };

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
    migrate: migrateAndSeal,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.workersSubdomain !== undefined ? { workersSubdomain: options.workersSubdomain } : {}),
    ...(options.resolveWorkers !== undefined ? { resolveWorkers: options.resolveWorkers } : {}),
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
              // **What makes `pithy feature` true (#321).** It says "an isolated, fully-provisioned
              // feature environment", and one that needed three follow-up commands per branch was not
              // that. Every secret the registry declares mintable is created here, in the branch's own
              // scope, so nothing is shared with a declared environment and nothing is left to do.
              mint: storeSecretMinter({
                store,
                environment: scope.stanza,
                ...(options.audit !== undefined ? { audit: options.audit } : {}),
                // The kept value, never a fresh one: the seed signs with what this entry holds (#643).
                stated: (secret) => (kept && Object.hasOwn(kept.values, secret) ? kept.values[secret] : undefined),
              }),
            }),
        }
      : {}),
    ...(options.audit !== undefined ? { audit: options.audit } : {}),
    // Which feature, on every creation event. `provisionEnvironment` knows the names it wrote; only
    // this caller knows the branch they came from, and that is what an operator reads the trail for.
    auditMetadata: { feature: options.identity.slug, issue: options.identity.issue },
  });

  if (!kept) return report;
  const done = sealed as SealedFeatureSecrets | null;
  for (const name of done?.replaced ?? []) if (kept.generated.includes(name)) regenerated.add(name);
  return {
    ...report,
    featureSecrets: {
      path: kept.path,
      sealed: done?.sealed ?? [],
      written: done?.written ?? [],
      regenerated: [...regenerated].sort(),
    },
  };
}

/**
 * The feature's `SECRETS` database id, from the manifest this run just wrote — only an entry this feature
 * could have created, for the reason every other read of that file gives. `null` when there is none: a
 * project whose Workers compose no secrets capability, or one that declined the binding.
 */
async function featureSecretsDatabaseId(path: string, identity: FeatureIdentity): Promise<string | null> {
  const manifest = await readManifest(path);
  const resource = (manifest?.resources ?? []).find(
    (candidate) =>
      candidate.kind === "d1" && candidate.binding === SECRETS_D1_BINDING && isOwnedByFeature(identity, candidate),
  );
  return resource?.id ?? null;
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
  /** Where the config directory is — the kept secrets file's home. Defaults to the real one. */
  paths?: StatePathOptions;
}

/**
 * Delete a feature's Worker scripts, then its Cloudflare resources.
 *
 * **Scripts first (#592).** A script deployed against a database that is already gone answers on
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
    for (const script of manifest?.scripts ?? []) {
      if (isScriptOwnedByFeature(options.identity, script)) await removeScript(script.name);
    }
    // A feature provisioned before scripts were recorded has none in its manifest, and one deployed
    // before #587 runs under the doubled shape. Both are found by recomputing from the Workers.
    for (const worker of options.workers) {
      for (const name of featureWorkerScriptNames(options.identity, provisionWorkerNames(worker))) {
        await removeScript(name);
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
    // A `global` secret is never touched: it is one account-level value every environment binds, and this
    // feature was binding the project's rather than a copy of it.
    if (options.store) {
      const scope = featureScope(options.identity);
      const registry: SecretRegistry = Object.assign(
        {},
        ...options.capabilities.map((capability) => workerSecretRegistry([capability]) ?? {}),
      );
      for (const [binding, entry] of Object.entries(registry)) {
        if (entry.backend !== "cf-secrets-store" || entry.scope !== "environment" || entry.keyed) continue;
        await options.store.remove(scope.secretEntry(binding, "environment"));
      }
    }
  } catch (error) {
    // Carried, never replaced. `deleted` is what this run destroyed, by kind, name and id — the three
    // facts an operator needs to finish the teardown by hand. Nothing from the throw is copied into it.
    throw deprovisionReport.carry(error, deleted);
  }

  // The manifest is removed only on a clean pass. It is the record of what is left to delete, and a
  // teardown that failed partway is precisely when a re-run needs it.
  await rm(path, { force: true });
  // And the values it kept (#643). The deployment that held them is gone, and a kept credential for nothing is
  // one more file with a key in it.
  await forgetFeatureSecrets(options.identity, options.paths);
  return { deleted };
}
