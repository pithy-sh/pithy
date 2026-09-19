// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import type { CloudflareWorkflowsClient } from "@pithy-sh/cloudflare/src/workflows/workflowsClient";
import type { FeatureResourceKind } from "@pithy-sh/core/src/naming/feature";
import type { FeatureIndex } from "../capabilities/hostRegistry";
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
 * **The Worker scripts a feature deploys, as teardown needs them (#592).**
 *
 * Not a {@link ResourceProvisioner}: provisioning never creates a script. It names one, in the generated
 * config `pithy deploy` reads, and the deploy uploads it — so a script may have been named and never
 * deployed, and teardown has to ask before it deletes. The name is the id; Cloudflare addresses a script
 * by nothing else.
 */
export interface WorkerScripts {
  /**
   * Whether a script of exactly this name is deployed on the account. Refuses rather than answering where
   * the account is unconfirmed: an empty listing from an account nothing claims is not an absence, and a
   * `true` from one is somebody else's deployment.
   */
  exists(name: string): Promise<boolean>;
  /**
   * Delete the script by name, **whatever still binds it**. Called only for a name {@link WorkerScripts.exists}
   * just confirmed, and only by feature teardown for a name the feature could have deployed.
   *
   * Cloudflare refuses to delete a script another Worker still binds, and a feature's Workers bind each
   * other: `web` calls `api`, and both are the feature's copies. Deleting callers first would need the graph,
   * and teardown does not have it — a script recorded in the manifest may belong to a Worker that has left the
   * branch, a Durable Object binding reaches a sibling too, and two Workers can call each other. Every script
   * this deletes is the feature's own, going in the same pass, so it is forced (#592).
   */
  delete(name: string): Promise<void>;
}

/**
 * **The account's Workflow definitions, as teardown needs them (#643).** A feature's scripts host Workflows —
 * every kit host does — and Cloudflare does not say whether deleting a script deletes the Workflows it hosts, so
 * teardown finds them by their hosting script's exact name and deletes each one itself.
 */
export interface WorkflowDefinitions {
  /** The name of every Workflow whose hosting script is exactly one of these. */
  hostedBy(scripts: ReadonlySet<string>): Promise<string[]>;
  /** Delete a Workflow by name. One already gone is not an error. */
  delete(name: string): Promise<void>;
}

/**
 * **The account's API tokens, as feature teardown needs them (#643):** a feature's secrets manager holds a token
 * of its own, named for the feature, and teardown revokes it by that exact name.
 */
export interface FeatureApiTokens {
  /** Delete every account token of exactly this name. Resolves how many went; none is not an error. */
  deleteByName(name: string): Promise<number>;
}

/** The default {@link WorkflowDefinitions}, over the account's Workflows REST client. */
export function cloudflareWorkflowDefinitions(
  workflows: Pick<CloudflareWorkflowsClient, "listWorkflows" | "deleteWorkflow">,
): WorkflowDefinitions {
  return {
    hostedBy: async (scripts) =>
      (await workflows.listWorkflows()).filter((one) => scripts.has(one.script_name)).map((one) => one.name),
    delete: async (name) => void (await workflows.deleteWorkflow(name)),
  };
}

/** The default {@link FeatureApiTokens}, over the account's token manager. */
export function cloudflareFeatureApiTokens(clients: CloudflareClients): FeatureApiTokens {
  return { deleteByName: (name) => clients.accountTokens().deleteTokensByName(name) };
}

/**
 * The default {@link WorkerScripts}, over the account's Workers manager. The account travels with the
 * clients for the reason it does in {@link cloudflareProvisioners} (#378): what vouches for it is what
 * makes a listing's answer one a delete may act on.
 */
export function cloudflareWorkerScripts(clients: CloudflareClients, account: ConfirmedAccount): WorkerScripts {
  const workers = clients.workers();
  return {
    exists: async (name) =>
      (await findOnConfirmedAccount({
        ...account,
        what: `the ${name} Worker`,
        find: () => workers.getWorker(name),
      })) !== null,
    // Forced: see `WorkerScripts.delete`. A Worker outside the feature that binds one of its Workers breaks,
    // as it would when the feature's Worker stopped answering; the kit never writes such a binding, because
    // a feature's service targets are always its own copies.
    delete: (name) => workers.deleteWorker(name, { force: true }),
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

/**
 * Everything feature teardown deletes and reports, by kind: the resources provisioning creates, and the
 * Worker scripts it names for deploy (#592).
 */
export type TeardownKind = FeatureResourceKind | "worker" | "workflow" | "api_token" | "vectorize";

/** The resource kind recorded on a provisioning audit event. */
export const AUDIT_RESOURCE_TYPE: Record<TeardownKind, string> = {
  d1: "cf_d1",
  kv: "cf_kv",
  r2: "cf_r2",
  // The type every capability deprovisioner already records a removed Worker under.
  worker: "cf_worker",
  // A Workflow definition a feature's scripts hosted, deleted by name (#643).
  workflow: "cf_workflow",
  // A feature manager's own account API token (#643).
  api_token: "cf_api_token",
  // A feature's own Vectorize index (#643).
  vectorize: "cf_vectorize",
};

/**
 * **The indexes a feature creates for itself (#643)** — see `FeatureIndex` in `capabilities/hostRegistry.ts`.
 * `ensure` creates one only when absent and refuses one of another shape; `remove` deletes one if it is there.
 */
export interface FeatureIndexes {
  /** Create the index, and its metadata indexes, if absent. */
  ensure(index: FeatureIndex): Promise<void>;
  /** Delete the index by name. Resolves whether one was there. */
  remove(name: string): Promise<boolean>;
}
