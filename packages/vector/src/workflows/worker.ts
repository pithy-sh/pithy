// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { D1Database } from "@cloudflare/workers-types";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { classifiedSteps } from "@pithy-sh/core/src/workflow/faults";
import { workflowHostEntry } from "@pithy-sh/core/src/workflow/hostEntry";
import type { VectorIndexConfig } from "../config/config";
import { VectorWorkerConfig, type VectorWorkerIndex } from "../config/workerConfig";
import { vectorDocuments } from "../data/documents";
import { vectorDatabase } from "../data/tables";
import type { VectorAi } from "../embed/embed";
import { VectorIndexNotFoundError } from "../error/errors";
import { compileFilter } from "../index/filter";
import type { VectorStore } from "../index/index";
import { type ReprocessReport, reprocessIndex } from "./reprocess";
import { vectorWorkflowRetry } from "./retryPolicy";
import { VECTOR_CAPABILITY, VectorReprocessParams } from "./specs";

/**
 * The prebuilt vector worker. `pithy vector provision` deploys one per environment; the adopter authors no
 * code for it. It hosts the reprocess Workflow — a thin durable shell around the tested orchestration in
 * `reprocess.ts` — and nothing else. Every search route lives in the app worker.
 *
 * This module imports `cloudflare:workers`, so it runs only in the Workers runtime and is excluded from the
 * node meta-test glob.
 *
 * Its config arrives as `VECTOR_CONFIG`, a **projection** of the capability's config rather than the config
 * itself: an index's `metadata` is a live Zod schema, which cannot travel through a wrangler var. The
 * projection carries the introspected filterable descriptors instead, which is all this worker needs to
 * validate a `--filter`.
 *
 * **The default export is what makes this an ES module** (#426). It exports one Workflow class and has no
 * cron, so until now it exported no default — and wrangler infers a worker's module format from exactly
 * that, so the build read it as a service worker and refused `cloudflare:workers` outright. The host did not
 * build, `pithy dev` carried on past it, and a reprocess dispatched at it went nowhere. The refusal it
 * exports is the honest body for a host with no request surface; see `@pithy-sh/core/src/workflow/hostEntry`.
 */

/** The vector worker's env: the corpus database, the AI binding, its config, and one Vectorize binding per index. */
export interface VectorWorkerEnv {
  /** The app database the document corpus lives in. */
  DB: D1Database;
  /** The Workers AI binding. Marked remote in the host config — Workers AI has no local emulation. */
  AI: VectorAi;
  /** The projected vector config as one JSON string, filled at provision. */
  VECTOR_CONFIG?: string;
  /** Each index's Vectorize binding, addressed by the name its config declares. */
  [binding: string]: unknown;
}

/** Parse the projected config off the env. A worker with no config cannot do anything but say so. */
function workerConfig(env: VectorWorkerEnv): VectorWorkerConfig {
  if (!env.VECTOR_CONFIG) {
    throw new InternalError({
      message: "The vector worker has no configuration.",
      action: "Run `pithy vector provision` — it deploys this worker with its config.",
      detail: "VECTOR_CONFIG was absent from the worker env",
    });
  }
  return VectorWorkerConfig.parse(JSON.parse(env.VECTOR_CONFIG));
}

/** The index's config in the shape the shared code takes. Metadata is absent by design — see the file note. */
function indexConfig(index: VectorWorkerIndex): VectorIndexConfig {
  return {
    model: index.model,
    dimensions: index.dimensions,
    metric: index.metric,
    binding: index.binding,
    ...(index.namespace !== undefined ? { namespace: index.namespace } : {}),
  };
}

/** Re-embed a corpus, one journalled page per step. */
export class VectorReprocessWorkflow extends WorkflowEntrypoint<VectorWorkerEnv, VectorReprocessParams> {
  override async run(event: WorkflowEvent<VectorReprocessParams>, step: WorkflowStep): Promise<ReprocessReport> {
    const params = VectorReprocessParams.parse(event.payload);
    const config = workerConfig(this.env);

    const index = config.indexes[params.index];
    if (!index) {
      throw new VectorIndexNotFoundError({
        detail: `no index '${params.index}' in VECTOR_CONFIG; deployed: ${Object.keys(config.indexes).join(", ") || "none"}`,
      });
    }

    const store = this.env[index.binding] as VectorStore | undefined;
    if (!store) {
      throw new InternalError({
        message: "The vector worker cannot reach that index.",
        action: "Re-run `pithy vector provision` so the worker binds every configured index.",
        detail: `the \`${index.binding}\` Vectorize binding was not present on the worker env`,
      });
    }

    // Compiled against the *provisioned* metadata indexes, so a filter naming a field this index cannot
    // filter on fails before a single document is re-embedded.
    const filter = params.filter ? compileFilter(index.filterable, params.filter) : undefined;

    return reprocessIndex(
      {
        documents: vectorDocuments(vectorDatabase(this.env.DB)),
        store,
        ai: this.env.AI,
        index: indexConfig(index),
        indexName: params.index,
        now: () => new Date(),
      },
      // Under `vectorWorkflowRetry`: an unreachable embedding model re-drives the page, and a pinned
      // dimension, a filter the index cannot answer, or a shape nobody recognises fails on page one —
      // which is where a config error belongs in a job thousands of pages long.
      classifiedSteps(step, vectorWorkflowRetry, NonRetryableError),
      {
        ...(params.all !== undefined ? { all: params.all } : {}),
        ...(filter ? { filter } : {}),
        ...(params.pageSize !== undefined ? { pageSize: params.pageSize } : {}),
      },
    );
  }
}

/**
 * The module's default export, and therefore its format. See `hostEntry` for why a Workflow host needs one
 * at all, and why this one refuses rather than being empty: nothing reaches this worker over HTTP — search
 * lives in the app worker, and a re-embed starts on the `VECTOR_REPROCESS` binding.
 */
export default workflowHostEntry(VECTOR_CAPABILITY);
