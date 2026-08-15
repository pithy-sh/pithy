// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { rm } from "node:fs/promises";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { type FeatureIdentity, type FeatureResourceKind, featureResourceName } from "@pithy-sh/core/src/naming/feature";
import { featureScope } from "@pithy-sh/core/src/naming/provisionScope";
import { partialWriteReport } from "@pithy-sh/secrets/src/cli/partialWrite";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/bindings";
import { initialMasterKeyConfig } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import type { CliAuditEmit } from "../audit/cliAudit";
import { storeSecretMinter } from "../capabilities/mintSecrets";
import {
  type BackendRunner,
  type ProvisionReport,
  type ProvisionWorker,
  provisionEnvironment,
} from "../provision/environment";
import { AUDIT_RESOURCE_TYPE, ProvisionAuditActions, type ResourceProvisioners } from "../provision/resources";
import { secretsStoreBindings, workerSecretRegistry } from "../provision/secretBindings";
import type { SecretsStore } from "../provision/store";
import { provisionableBindings } from "./bindings";
import {
  emptyManifest,
  type FeatureManifest,
  type FeatureResource,
  manifestPath,
  readManifest,
  writeManifest,
} from "./manifest";

/**
 * `pithy provision --feature` — one branch's ephemeral Cloudflare environment.
 *
 * The work is `provisionEnvironment`'s, unchanged for every environment a project has. What is a
 * feature's own, and lives here, is the two things a *deployed* environment has no equivalent of: the
 * branch-derived naming ({@link featureScope}, with no environment segment because a feature *is* an
 * environment), and the manifest that lets `destroy` delete exactly what was created and nothing else.
 *
 * `destroy` reverses it: delete the manifest's resources, then reconcile by recomputing each expected
 * name, so a partial-failed provision still cleans up fully.
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
  /** Migration runner seam (default: `migrateProject`). */
  migrate?: BackendRunner;
  /** Seed runner seam (default: `seedProject`). */
  seed?: BackendRunner;
  /** Worker-resolution seam (default: the real `apps/` resolver), so tests fix the worker set. */
  resolveWorkers?: (projectDir: string) => Promise<ProvisionWorker[]>;
  /**
   * The account's Secrets Store, when one is reachable. Given it, the feature gets its **own** master
   * key and its Workers get their `secrets_store_secrets` stanza; without it the feature is provisioned
   * exactly as it was before, and the omission is visible in the report rather than silent.
   */
  store?: SecretsStore;
  /** Audit emitter. Defaults to recording nothing, so a caller without audit wiring still works. */
  audit?: CliAuditEmit;
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
  if (store) {
    const masterKey = scope.secretEntry(MASTER_KEY_BINDING, "environment");
    if (!(await store.exists(masterKey))) {
      await store.put(masterKey, JSON.stringify(await initialMasterKeyConfig()));
    }
  }

  const report = await provisionEnvironment({
    projectDir: options.projectDir,
    scope,
    capabilities: options.capabilities,
    provisioners: options.provisioners,
    // A feature environment is created empty; without fixtures there is nothing in it to check.
    seedData: true,
    record: {
      load: async () => {
        const existing = await readManifest(path);
        assertManifestBelongs(options.identity, existing);
        // Carry forward only entries this feature could have created. Keeping a foreign one would
        // re-persist it under a freshly-written, legitimate-looking header — laundering it into what
        // `destroy` later deletes.
        return (existing?.resources ?? []).filter((resource) => isOwnedByFeature(options.identity, resource));
      },
      save: async (resources) => {
        const manifest: FeatureManifest = {
          ...emptyManifest({ ...options.identity, env: FEATURE_ENVIRONMENT }),
          resources,
        };
        await writeManifest(path, manifest);
      },
    },
    ...(options.migrate !== undefined ? { migrate: options.migrate } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.resolveWorkers !== undefined ? { resolveWorkers: options.resolveWorkers } : {}),
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
              }),
            }),
        }
      : {}),
    ...(options.audit !== undefined ? { audit: options.audit } : {}),
    // Which feature, on every creation event. `provisionEnvironment` knows the names it wrote; only
    // this caller knows the branch they came from, and that is what an operator reads the trail for.
    auditMetadata: { feature: options.identity.slug, issue: options.identity.issue },
  });

  return report;
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
   * The account's Secrets Store, when one is reachable. Teardown removes every entry this feature could
   * have created — and only those. An entry left behind is a live credential in a flat, account-wide
   * namespace with nothing pointing at it.
   */
  store?: SecretsStore;
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
  const remove = async (kind: FeatureResourceKind, name: string, id: string): Promise<void> => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    await options.provisioners[kind].delete(id);
    seen.add(key);
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

  // Everything from here destroys infrastructure, and `deleted` grows one resource at a time. A throw
  // anywhere inside used to take the whole list with it — the resources were gone and the record of
  // which ones was not, on the command whose entire output is that record (#380). It is carried on the
  // failure instead, and the failure itself is rethrown untouched: teardown still stops, because a
  // delete that failed for a reason belonging to the account — a revoked token, a resource another
  // project holds — is not a reason to keep deleting.
  try {
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
  return { deleted };
}
