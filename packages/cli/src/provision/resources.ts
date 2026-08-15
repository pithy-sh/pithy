// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { FeatureResourceKind } from "@pithy-sh/core/src/naming/feature";
import { type ConfirmedAccount, findOnConfirmedAccount } from "../cloudflare/accountAnswer";

/**
 * The control-plane operations provisioning needs for one resource kind, and the Cloudflare-backed
 * implementation of them.
 *
 * Separate from the orchestration above it because the orchestration is the same for every
 * environment a project has — a branch's ephemeral one and a declared `staging` alike — while this is
 * the one part that talks to an account. Injectable so every test above runs without credentials.
 */

/** The control-plane operations provisioning needs for one resource kind. */
export interface ResourceProvisioner {
  /** Find a resource by its exact name, returning its id, or null when absent (id = uuid/nsId, or the bucket name for r2). */
  find(name: string): Promise<{ id: string } | null>;
  /** Create the resource by name and return its id. */
  create(name: string): Promise<{ id: string }>;
  /** Delete the resource by id. Idempotent — a missing resource is not an error. */
  delete(id: string): Promise<void>;
}

/** One provisioner per provisionable resource kind. */
export type ResourceProvisioners = Record<FeatureResourceKind, ResourceProvisioner>;

/**
 * The default provisioners, backed by the `@pithy-sh/cloudflare` control-plane clients. For D1 and KV the
 * id is the CF-assigned uuid/namespace id; for R2, which has no separate id, the bucket name is the id.
 *
 * **`find` is where a not-found becomes a creation, so it is where the account has to be settled (#378).**
 * Both callers are find-or-create: `provisionEnvironment` creates whatever `find` did not return, and
 * `destroyFeature` reconciles by expected name. An empty listing from an account nothing claims is not
 * an absence, and reading it as one stands a real D1, KV namespace or R2 bucket up in somebody else's
 * account — a creation no re-run can walk back, since the second run finds what the first made. So the
 * account travels with the clients, `find` refuses instead of returning `null`, and the lookup is not
 * even attempted: the round trip's answer could not be believed either way.
 *
 * **Known limitation, R2 only:** the delete here is the plain control-plane one, and R2 refuses to delete
 * a bucket that still holds an object or a dangling multipart upload — so a feature bucket that was
 * written to fails teardown. Emptying it first needs the S3 key pair, which the control-plane clients do
 * not carry (`pithy storage deprovision --storage` takes it as a flag for exactly this reason). Wiring
 * that through the feature lifecycle is the fix; until then, empty the bucket by hand.
 */
export function cloudflareProvisioners(clients: CloudflareClients, account: ConfirmedAccount): ResourceProvisioners {
  const d1 = clients.d1Provisioner();
  const kv = clients.kvProvisioner();
  const r2 = clients.r2Provisioner();
  return {
    d1: {
      find: async (name) => {
        const found = await findOnConfirmedAccount({
          ...account,
          what: `the ${name} database`,
          find: () => d1.findDatabaseByName(name),
        });
        return found ? { id: found.uuid } : null;
      },
      create: async (name) => ({ id: (await d1.createDatabase(name)).uuid }),
      delete: (id) => d1.deleteDatabase(id),
    },
    kv: {
      find: async (name) => {
        const found = await findOnConfirmedAccount({
          ...account,
          what: `the ${name} KV namespace`,
          find: () => kv.findNamespaceByTitle(name),
        });
        return found ? { id: found.id } : null;
      },
      create: async (name) => ({ id: (await kv.createNamespace(name)).id }),
      delete: (id) => kv.deleteNamespace(id),
    },
    r2: {
      find: async (name) => {
        const found = await findOnConfirmedAccount({
          ...account,
          what: `the ${name} bucket`,
          find: () => r2.findBucketByName(name),
        });
        return found ? { id: found.name } : null;
      },
      create: async (name) => ({ id: (await r2.createBucket(name)).name }),
      delete: (id) => r2.deleteBucket(id),
    },
  };
}

/**
 * Audit actions provisioning records. Creating and — especially — deleting a resource changes real
 * infrastructure, and both run headlessly in CI, so "who deleted this, and what exactly went?" must be
 * answerable after the fact.
 *
 * **Named for provisioning, not for features**, since the same two events are emitted for a declared
 * environment. The event's own `environment` field says which one it was; a `feature/` prefix on a
 * `staging` event would be a sentence contradicting the row it sits in.
 */
export const ProvisionAuditActions = {
  /** A Cloudflare resource was created. */
  resourceCreated: "provision/resource_created",
  /** A Cloudflare resource was deleted during teardown. */
  resourceDeleted: "provision/resource_deleted",
} as const;

/**
 * Where a provisioning run's audit trail is written. **Not the environment being provisioned.**
 *
 * That environment's database may not exist yet — standing it up is what the command is for — so keying
 * the trail on it would resolve nothing and silently drop every creation event. And a feature's is
 * deleted by `destroy`, so a record written there dies with the thing it was recording. Both defeat the
 * point of auditing a headless CI run.
 *
 * It is a **routing** choice and never an `actedOn` claim: each event states the environment it acted on
 * in its own `environment` field, which is where the real answer is known.
 */
export const AUDIT_DESTINATION_ENV = "dev";

/** The resource kind recorded on a provisioning audit event. */
export const AUDIT_RESOURCE_TYPE: Record<FeatureResourceKind, string> = {
  d1: "cf_d1",
  kv: "cf_kv",
  r2: "cf_r2",
};
