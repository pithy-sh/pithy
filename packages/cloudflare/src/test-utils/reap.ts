// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Cloudflare } from "cloudflare";
import { CloudflareClients } from "../client/clients";
import {
  emptyTestBucket,
  type IntegrationCreds,
  type ReapableKind,
  staleTestResourceNames,
  testResourceAge,
} from "./harness";

/**
 * The reap registry: every throwaway resource kind a live suite can mint, in one place, swept once per
 * integration run.
 *
 * ## Why this exists, and why per-suite reaping was never enough
 *
 * {@link ReapableKind} and `reapStaleTestResources` are generic — they know how to reap *a* kind, and
 * nothing about which kinds exist. So a kind was reaped only where some suite happened to hand the
 * reaper a `list`/`remove` pair, and five such call sites covered the whole repo. Secrets Store
 * entries, Queues, and API tokens had none at all, which is why eight `pithy-int-secret-…` entries sat
 * on a real account with nothing in the repo able to reclaim them, ever.
 *
 * Two failures compound, and the second is the one that makes per-suite reaping structurally wrong.
 *
 * **A reaper registered in a suite's `beforeAll` does not run when that suite skips.** Every live suite
 * is a `describe.skipIf(...)`, and Vitest runs no hooks inside a skipped suite. So the reaper is gated
 * on exactly the credential whose absence lets debris accumulate: without `R2_CREDENTIALS` the R2
 * suite skips, and because D1 reaping lived inside `@pithy-sh/storage`'s bundle, the **D1** reaper went
 * offline with it. A reaper must never be gated on the same condition as the suite that dirties the
 * account.
 *
 * **And reaping was per-suite, not per-run.** `test:integration --filter @pithy-sh/vector` mints
 * Vectorize indexes and reaps nothing, because the only index reaper lived in `@pithy-sh/cloudflare`.
 * Cross-package coverage was accidental.
 *
 * So the sweep moved to a Vitest `globalSetup` (see `integrationSetup.ts`), which runs once per project
 * before any suite is collected and cannot be skipped by a suite's gate. A new live suite inherits
 * cleanup instead of remembering to arrange it.
 *
 * ## What is deliberately still not reaped
 *
 * Resources composed under {@link RESERVED_TEST_PROJECT} — `pithy feature provision`'s ephemeral D1 and
 * KV, which a live test provisions through the *product's* namer because the names are the thing under
 * test. `testResourceAge` cannot read an age out of `pithy-int-test-dev-73-slug-db`, and returns null
 * rather than guessing. That conservatism is correct and stays: failing to clean up costs pennies, and
 * deleting a resource a running suite still owns turns a green run red for reasons nobody can see. Those
 * suites tear down in an unconditional `afterAll`; an interrupted run leaves debris that must be removed
 * by hand. `CONTRIBUTING.md` says so out loud rather than implying the sweep covers everything.
 */

/** A kind that cannot be reaped this run, and the credential it is waiting on. */
export interface SkippedReapKind {
  /** The human label, matching the kind it stands in for. */
  label: string;
  /** Why it was skipped — names the missing variable, so the report is actionable. */
  skipped: string;
}

/** One entry in a reap plan: a kind that can be swept, or a named reason it cannot. */
export type ReapPlanEntry = (ReapableKind & { label: string }) | SkippedReapKind;

/** What one kind's sweep did. `skipped` is non-null only when the kind never ran. */
export interface ReapKindResult {
  /** The kind's label, as it appears in the plan. */
  label: string;
  /** Names successfully removed. */
  reaped: string[];
  /** Names that matched but could not be removed — reported, never swallowed. */
  failed: string[];
  /** The reason this kind did not run, or null when it did. */
  skipped: string | null;
}

/** Whether a plan entry is a stand-in for a kind that cannot run. */
function isSkipped(entry: ReapPlanEntry): entry is SkippedReapKind {
  return "skipped" in entry;
}

/** Every label in a plan, in plan order — what a test asserts against so a dropped kind is visible. */
export function reapPlanLabels(plan: readonly ReapPlanEntry[]): string[] {
  return plan.map((entry) => entry.label);
}

/**
 * Sweep every kind in a plan and report what went.
 *
 * Never throws, and never lets one kind's failure end the sweep: a reaper exists to help a suite, and a
 * housekeeping error that fails the run is worse than the debris it was cleaning. A listing that throws
 * yields an empty result for that kind; a removal that throws lands in `failed`, where it is visible.
 */
export async function reapKinds(
  plan: readonly ReapPlanEntry[],
  options: { now?: number; staleAfterMs?: number } = {},
): Promise<ReapKindResult[]> {
  const results: ReapKindResult[] = [];

  for (const entry of plan) {
    if (isSkipped(entry)) {
      results.push({ label: entry.label, reaped: [], failed: [], skipped: entry.skipped });
      continue;
    }

    const reaped: string[] = [];
    const failed: string[] = [];
    let names: string[];
    try {
      names = await entry.list();
    } catch {
      results.push({ label: entry.label, reaped, failed, skipped: null });
      continue;
    }

    for (const name of staleTestResourceNames(names, options)) {
      try {
        await entry.remove(name);
        reaped.push(name);
      } catch {
        failed.push(name);
      }
    }
    results.push({ label: entry.label, reaped, failed, skipped: null });
  }

  return results;
}

/**
 * Build the sweep plan for an account.
 *
 * Alphabetical by label, so the set is readable as a list rather than as an accident of construction
 * order, and so a test can pin it. Every kind appears whether or not it can run — a kind that is missing
 * a credential reports *why*, because "nothing to reap" and "unable to reap" look identical in a log and
 * only one of them is fine.
 *
 * R2 is the one kind an API token cannot reclaim: Cloudflare refuses to delete a non-empty bucket, and
 * emptying one is an S3-protocol operation. So it needs the key pair, and says so when it lacks it.
 */
export function testResourceReapPlan(creds: IntegrationCreds): ReapPlanEntry[] {
  const clients = new CloudflareClients({ accountId: creds.accountId, apiToken: creds.apiToken });
  const sdk = new Cloudflare({ apiToken: creds.apiToken });
  const workers = clients.workers();
  const tokens = clients.accountTokens();
  const d1 = clients.d1Provisioner();
  const kv = clients.kvProvisioner();
  const vectorize = clients.vectorizeProvisioner();
  const r2 = clients.r2Provisioner();

  return [
    {
      // Minted by `accountTokensManager.integration.test.ts`. Delete addresses a token by id, so the
      // listing is what turns a stale name back into one.
      label: "API token",
      list: async () => (await tokens.listTokens()).map((token) => token.name),
      remove: async (name) => {
        await tokens.deleteTokensByName(name);
      },
    },
    {
      label: "D1 database",
      list: async () => (await d1.listDatabases()).map((database) => database.name),
      remove: async (name) => {
        const found = (await d1.listDatabases()).find((database) => database.name === name);
        if (found) await d1.deleteDatabase(found.uuid);
      },
    },
    {
      label: "KV namespace",
      list: async () => (await kv.listNamespaces()).map((namespace) => namespace.title),
      remove: async (title) => {
        const found = (await kv.listNamespaces()).find((namespace) => namespace.title === title);
        if (found) await kv.deleteNamespace(found.id);
      },
    },
    {
      // Queues are created with the raw SDK in the live suite (the manager addresses an existing queue
      // by name), so the reaper reaches for the same surface rather than inventing a provisioner.
      label: "Queue",
      list: async () => {
        const names: string[] = [];
        for await (const queue of sdk.queues.list({ account_id: creds.accountId })) {
          if (queue.queue_name) names.push(queue.queue_name);
        }
        return names;
      },
      remove: async (name) => {
        for await (const queue of sdk.queues.list({ account_id: creds.accountId })) {
          if (queue.queue_name === name && queue.queue_id) {
            await sdk.queues.delete(queue.queue_id, { account_id: creds.accountId });
            return;
          }
        }
      },
    },
    creds.r2
      ? {
          label: "R2 bucket",
          list: async () => (await r2.listBuckets()).map((bucket) => bucket.name),
          remove: async (name) => {
            await emptyTestBucket(creds, name);
            await r2.deleteBucket(name);
          },
        }
      : {
          label: "R2 bucket",
          skipped: "no R2_CREDENTIALS: a bucket cannot be emptied, and R2 refuses to delete a non-empty one.",
        },
    creds.secretsStoreId
      ? {
          label: "Secrets Store entry",
          list: async () => (await clients.secrets(creds.secretsStoreId).listSecrets()).map((entry) => entry.name),
          // `deleteSecretIfPresent`, not `deleteSecret`: `ReapableKind.remove` is contractually
          // idempotent, and another runner's sweep reaching the entry first must not read as a failure.
          remove: async (name) => {
            await clients.secrets(creds.secretsStoreId).deleteSecretIfPresent(name);
          },
        }
      : {
          label: "Secrets Store entry",
          skipped: "no SECRETS_STORE_ID: the store to sweep is unknown.",
        },
    {
      label: "Vectorize index",
      list: async () => (await vectorize.listIndexes()).map((index) => index.name),
      remove: (name) => vectorize.deleteIndex(name),
    },
    {
      label: "Worker script",
      list: async () => (await workers.listWorkers()).map((script) => script.id ?? "").filter(Boolean),
      remove: (name) => workers.deleteWorker(name),
    },
  ];
}

/**
 * Reclaim every stale throwaway resource on the account, across every kind.
 *
 * The entry point a `globalSetup` calls. Reports one line per kind that did something or could not run;
 * a kind with nothing to do stays quiet, because a clean account should produce a clean log.
 */
export async function reapAllStaleTestResources(
  creds: IntegrationCreds,
  options: { now?: number; staleAfterMs?: number } = {},
): Promise<ReapKindResult[]> {
  const results = await reapKinds(testResourceReapPlan(creds), options);

  for (const result of results) {
    if (result.skipped) console.warn(`stale ${result.label}(s) were not swept: ${result.skipped}`);
    if (result.reaped.length > 0) {
      console.warn(`reaped ${result.reaped.length} stale ${result.label}(s): ${result.reaped.join(", ")}`);
    }
    if (result.failed.length > 0) {
      console.warn(`could not reap ${result.failed.length} stale ${result.label}(s): ${result.failed.join(", ")}`);
    }
  }

  return results;
}

/** Re-exported so a caller reasoning about one name does not need two imports. */
export { testResourceAge };
