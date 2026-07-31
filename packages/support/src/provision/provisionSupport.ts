// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { workflowHostName } from "@pithy-sh/core/src/workflow/naming";
import { type ManagedEnvironment, managedEnvironments } from "@pithy-sh/secrets/src/scope";

/**
 * The provisioning orchestration for the support capability — the live counterpart to
 * `pithy add support`'s config wiring.
 *
 * Three things have to exist before a support inbox works, and none of them can be a binding an
 * adopter hand-writes: the R2 bucket attachments and raw messages land in, the prebuilt classification
 * worker per environment, and — the one that actually delivers the mail — an Email Routing rule
 * pointing the support address at the app worker.
 *
 * The live Cloudflare/wrangler steps sit behind the {@link SupportProvisioner} seam, so the
 * orchestration (order, idempotency, per-env fan-out) is unit-tested without touching Cloudflare.
 * Every step is idempotent; re-running is a no-op.
 *
 * ## The routing rule is opt-in, and that is a safety decision
 *
 * `ensureRoutingRule` returns `skipped: true` when no routing config is supplied, exactly as
 * `@pithy-sh/email`'s does — because **enabling Email Routing on a zone points its MX at Cloudflare.**
 * Creating a rule on the wrong zone would move an adopter's real inbound mail off their existing
 * provider, which is not a mistake a provisioning command gets to make on their behalf. So the zone,
 * the address, and the target worker are all explicit flags, and a project that has not decided yet
 * provisions everything else and adds the rule later.
 *
 * The rule name is `pithy-support-inbound`, deliberately distinct from `@pithy-sh/email`'s
 * `pithy-email-bounce`. Idempotency in `ensureWorkerRoute` keys on the rule *name*, so sharing one
 * would make whichever capability provisioned second silently believe its rule already existed.
 */

/** The name of the Email Routing rule this capability creates. Distinct from the bounce handler's. */
export const SUPPORT_ROUTING_RULE_NAME = "pithy-support-inbound";

/**
 * The deployed Worker name for an environment — also its resolved config basename. Delegates to core's
 * {@link workflowHostName}, so the name the CLI audits and deletes under cannot drift from the name it
 * deploys under.
 */
export function supportWorkerName(env: ManagedEnvironment): string {
  return workflowHostName("support", env);
}

/** The live Cloudflare/wrangler seam. Each step must be idempotent. */
export interface SupportProvisioner {
  /**
   * Verify account prerequisites before any resource is created — most importantly a registered
   * `workers.dev` subdomain, which Cloudflare requires to deploy the Workflow-hosting worker.
   */
  preflight(): Promise<void>;
  /**
   * Create (or reuse) the R2 bucket attachments and raw messages live in. Idempotent.
   *
   * Returns `skipped: true` when the capability is configured with attachments off — a bucket nobody
   * writes to is a resource an adopter did not ask for.
   */
  ensureBucket(): Promise<{ bucket: string; created: boolean; skipped: boolean }>;
  /** Deploy the prebuilt classification worker for this environment. */
  deployWorker(env: ManagedEnvironment): Promise<void>;
  /**
   * Create or drop the full-text index in this environment's app database, to match `search.fts`.
   *
   * A provisioning step rather than a migration, because the index is **derived** — every row in it
   * comes from `pithy_support_messages` and `reindexThread` rebuilds it on demand. That is the line a
   * migration is for: schema whose loss loses data. Keeping it here is also what makes the flag safe
   * to toggle at all, since a config-conditional migration removed from the set is corruption to
   * Kysely and blocks `pithy migrate` for every capability sharing the database.
   */
  ensureSearchIndex(env: ManagedEnvironment): Promise<{ created: boolean; dropped: boolean }>;
  /**
   * Ensure the inbound Email Routing rule that delivers the support address to the app worker.
   * Idempotent, keyed on the rule name. Returns `skipped: true` when no routing config was supplied.
   */
  ensureRoutingRule(): Promise<{ created: boolean; skipped: boolean }>;
}

/** What provisioning produced. */
export interface SupportProvisionResult {
  /** The R2 bucket, and whether it had to be created. */
  bucket: { bucket: string; created: boolean; skipped: boolean };
  /** The environments a classification worker was deployed for. */
  environments: ManagedEnvironment[];
  /** What the full-text index did, per environment — created, dropped, or already correct. */
  search: Array<{ env: ManagedEnvironment; created: boolean; dropped: boolean }>;
  /** Whether the inbound routing rule was created, already present, or skipped. */
  routing: { created: boolean; skipped: boolean };
}

/**
 * Provision the support infrastructure.
 *
 * The order matters and is the inverse of how it fails: the bucket exists before a worker that could
 * write to it, and **the routing rule is last** — creating it first would start delivering mail to a
 * Worker whose classification host is not deployed yet, which is a window where real customer
 * messages arrive and stay `uncategorized` with nothing to say why.
 */
export async function provisionSupport(provisioner: SupportProvisioner): Promise<SupportProvisionResult> {
  await provisioner.preflight();
  const bucket = await provisioner.ensureBucket();
  const search: SupportProvisionResult["search"] = [];
  for (const env of managedEnvironments()) {
    await provisioner.deployWorker(env);
    // Per environment, because each has its own app database — and after the worker, so a database
    // that gains the index always has something able to write to it.
    search.push({ env, ...(await provisioner.ensureSearchIndex(env)) });
  }
  const routing = await provisioner.ensureRoutingRule();
  return { bucket, environments: managedEnvironments(), routing, search };
}

/** The teardown seam — the inverse of {@link SupportProvisioner}. Every step idempotent. */
export interface SupportDeprovisioner {
  /** Delete the env's classification worker. Idempotent. */
  deleteWorker(env: ManagedEnvironment): Promise<void>;
  /** Remove the inbound routing rule, so mail stops being delivered here. Idempotent. */
  removeRoutingRule(): Promise<{ removed: boolean }>;
  /**
   * Delete the R2 bucket **and everything in it** — every attachment and every raw message an adopter's
   * customers ever sent. Destructive, so the orchestration only calls it when explicitly asked.
   */
  deleteBucket(): Promise<void>;
}

/** Teardown options. By default the bucket is **kept**: it holds correspondence, not cache. */
export interface SupportDeprovisionOptions {
  /** Also delete the R2 bucket and its contents. Off by default. */
  deleteStorage?: boolean;
}

/**
 * Tear down the support infrastructure, reversing {@link provisionSupport}.
 *
 * The routing rule goes **first**, and that ordering is the whole point: stop new mail arriving before
 * removing the workers that would have handled it, or messages land in a Worker with no classification
 * host during the teardown. Stored correspondence is preserved unless explicitly requested — losing an
 * adopter's support history to a teardown flag would be unrecoverable.
 */
export async function deprovisionSupport(
  deprovisioner: SupportDeprovisioner,
  options: SupportDeprovisionOptions = {},
): Promise<void> {
  await deprovisioner.removeRoutingRule();
  for (const env of managedEnvironments()) {
    await deprovisioner.deleteWorker(env);
  }
  if (options.deleteStorage) await deprovisioner.deleteBucket();
}
