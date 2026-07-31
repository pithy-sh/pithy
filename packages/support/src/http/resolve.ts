// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { objectStore } from "@pithy-sh/storage/src/object/store";
import type { Context } from "hono";
import type { SupportWiring } from "../capability";
import { supportDatabase } from "../data/tables";
import { SUPPORT_R2_SECRET } from "../secret/registry";
import { supportWorkflowRegistry, supportWorkflows } from "../workflows/specs";
import type { HandlerDeps } from "./handlers";

/**
 * Turning a Worker env into the dependencies the handlers take.
 *
 * The pattern every capability uses: nothing below `resolve.ts` ever reads a binding off `env`, so
 * the handlers, the store, the reply path, and the ingest orchestration are all testable by handing
 * them objects. This is the one file that knows what `env.DB` is called.
 */

/** The bindings support reads. */
export interface SupportEnv extends SecretsStoreEnv {
  /** The app database every support table lives in. */
  DB: D1Database;
  /** Attachment and raw-message bytes. Optional — an inbox with attachments off never touches it. */
  SUPPORT_BUCKET?: R2Bucket;
}

/** Read the `DB` binding, or fail loudly rather than as a silent undefined three layers down. */
export function resolveDb(env: Record<string, unknown>): D1Database {
  const binding = env.DB;
  if (!binding) {
    throw new InternalError({
      message: "The support database binding is missing.",
      action: "Add the `DB` D1 binding to this Worker's wrangler.jsonc, then redeploy.",
      detail: 'D1 binding "DB" is not present on the worker env',
    });
  }
  return binding as D1Database;
}

/**
 * Start a classification.
 *
 * Dispatched through the registry rather than by reaching for the binding directly, so the params
 * are validated at the call site and a missing binding degrades to a logged skip — which is the
 * whole reason the job is declared `optional`. A project that has not run `pithy support provision`
 * still receives mail; its threads simply stay `uncategorized`.
 */
export function makeClassifyDispatcher(
  env: Record<string, unknown>,
  log: Logger,
): (messageId: string) => Promise<boolean> {
  return async (messageId) => {
    const { triggerWorkflow } = await import("@pithy-sh/core/src/workflow/dispatch");
    await triggerWorkflow(env, supportWorkflowRegistry, "support/classify", { messageId }, log);
    // Whether an instance actually started. `triggerWorkflow` degrades to a logged skip when the
    // binding is absent — correct for the inbound path, where a missing classifier must never stop
    // mail being stored — but a caller that reports success to a human needs to know the difference.
    // A dashboard told "reclassified" while nothing ran would keep saying so forever.
    return env[supportWorkflows.classify.binding] != null;
  };
}

/**
 * Build the object store attachment URLs are signed through.
 *
 * Returns undefined rather than throwing when the bucket is unbound: a deployment with attachments
 * off has no bucket by design, and a thread view must still render. Credentials resolve lazily
 * inside the seam, so this costs nothing until something is actually signed.
 */
export function resolveStore(env: SupportEnv): ReturnType<typeof objectStore> | undefined {
  if (!env.SUPPORT_BUCKET) return undefined;
  return objectStore({ bucket: env.SUPPORT_BUCKET, env, secretName: SUPPORT_R2_SECRET });
}

/** Build the per-request handler dependencies. */
export function makeResolveDeps(wiring: SupportWiring): (c: Context<PithyHonoEnv>) => Promise<HandlerDeps> {
  return async (c) => {
    const env = c.env as unknown as SupportEnv;
    const d1 = resolveDb(env as unknown as Record<string, unknown>);
    const log = c.var.log.child("support");

    return {
      db: supportDatabase(d1),
      d1,
      config: wiring.config,
      categories: wiring.categories,
      snippets: wiring.snippets,
      fts: wiring.config.search.fts,
      bucket: env.SUPPORT_BUCKET,
      store: resolveStore(env),
      // Bound at compose time when `email()` is composed; undefined otherwise, which the reply
      // handler turns into a `support/reply_failed` naming the missing capability.
      enqueue: wiring.enqueueEmail
        ? (input) => wiring.enqueueEmail?.(env as never, input) as Promise<{ jobId: string }>
        : undefined,
      dispatchClassify: makeClassifyDispatcher(env as unknown as Record<string, unknown>, log),
      emit: c.var.emit,
      log,
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
    };
  };
}
