// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { configureSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { StorageConfig } from "../config/config";
import { storageDatabase } from "../data/tables";
import { objectStore } from "../object/store";
import { STORAGE_R2_SECRET, storageSecretsRegistry } from "../secret/registry";
import { StorageSweepParams } from "./specs";
import { type SweepResult, sweepStorage } from "./sweep";

/**
 * The prebuilt storage sweep worker. `pithy storage provision` deploys one per environment; the
 * adopter authors none of it. It hosts a single Workflow — the orphan sweep — and fires it on a daily
 * cron.
 *
 * **Why its own worker rather than the app worker's `scheduled()`.** The sweep lists an entire bucket
 * and can delete from it. Keeping it out of the request-serving deployment means it cannot compete
 * with a user's download for CPU, and — more to the point — the app worker never needs a binding that
 * can delete arbitrary objects. It is also a Workflow rather than a plain scheduled pass because a
 * Worker invocation is wall-clock bounded while a Workflow step is not: a bucket with a million keys
 * is a thousand list pages, and that is a job you want checkpointed rather than restarted.
 *
 * This module imports `cloudflare:workers`, so it runs only in the Workers runtime and is excluded
 * from the node `.describe()` meta-test.
 */

/** The sweep worker's env: the app database, the bucket, the master key, and the resolved config. */
export interface StorageWorkerEnv extends SecretsStoreEnv {
  /** The app database the `pithy_storage_*` tables live in. */
  DB: D1Database;
  /** The bucket the sweep lists and deletes from. */
  STORAGE_BUCKET: R2Bucket;
  /** The resolved storage config as a JSON string, filled at provision. Absent falls back to defaults. */
  STORAGE_CONFIG?: string;
  /** This worker's own Workflow binding — how `scheduled()` starts an instance. */
  STORAGE_SWEEP: { create(options?: { id?: string; params?: unknown }): Promise<unknown> };
}

// A standalone worker, not assembled by `createBackend`, so wire the shared secrets accessor directly.
// The sweep aborts multipart uploads, which is an S3-protocol call, which needs the R2 credentials.
configureSharedSecrets({ registry: storageSecretsRegistry });

/** The orphan sweep, as a cron-triggered Workflow. One step, because one run is one reconciliation. */
export class StorageSweepWorkflow extends WorkflowEntrypoint<StorageWorkerEnv, StorageSweepParams> {
  override async run(event: WorkflowEvent<StorageSweepParams>, step: WorkflowStep): Promise<void> {
    // Parse rather than trust: an instance can be started by a cron, by `c.var.workflows.trigger`, or
    // by an operator through the dashboard, and only the first two have already been validated.
    const params = StorageSweepParams.parse(event.payload ?? {});
    const config = StorageConfig.parse(this.env.STORAGE_CONFIG ? JSON.parse(this.env.STORAGE_CONFIG) : {});

    // One durable step. A retry re-runs the whole reconciliation, which is safe precisely because the
    // sweep is idempotent — a second pass over a reconciled bucket finds nothing left to do.
    const result: SweepResult = await step.do("sweep", async () =>
      sweepStorage({
        db: storageDatabase(this.env.DB),
        store: objectStore({
          bucket: this.env.STORAGE_BUCKET,
          env: this.env,
          secretName: STORAGE_R2_SECRET,
        }),
        now: () => new Date(),
        ttlSeconds: params.olderThanSeconds ?? config.pendingTtlSeconds,
        dryRun: params.dryRun,
        maxPages: params.maxPages,
      }),
    );

    // The result is the run's only visible output, so it goes to the log — a sweep whose findings are
    // invisible is a sweep nobody can tell has stopped working.
    console.log("storage sweep", JSON.stringify(result));
  }
}

export default {
  /**
   * Cron entry: start one sweep instance per fire, with empty parameters — the defaults are the
   * scheduled behaviour. The same Workflow stays dispatchable with a payload (`dryRun`, a shorter
   * TTL, a page cap), which is how the sweep is exercised in staging without waiting for 03:00.
   */
  async scheduled(_controller: unknown, env: StorageWorkerEnv): Promise<void> {
    await env.STORAGE_SWEEP.create({ params: {} });
  },
};
