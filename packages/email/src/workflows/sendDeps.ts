// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { requireHostEnv } from "@pithy-sh/core/src/workflow/hostEnv";
import type { SecretBinding, SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { configureSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { EMAIL_LINK_SIGNING_KEY_BINDING, emailSigningRegistry, resolveSigningKeys } from "../crypto/signingKey";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import type { SendWorkflowBinding } from "../send/enqueue";
import type { EmailSender } from "../send/sender";
import { catalogLayers, catalogsFromEnv } from "../templates/messages";
import { type EmailHostEnv, emailHostEnv } from "./hostEnv";
import type { SendWorkflowInstances } from "./instances";
import type { SendBatchDeps } from "./sendBatch";

/**
 * The email worker's env as the runtime hands it over — bindings as objects, every var as a string.
 *
 * The *shape the host runs on* is {@link EmailHostEnv}, which is this parsed: numbers as numbers, the
 * theme as a validated `EmailTheme`, `SCHEDULER_ENABLED` as a boolean. This type stays because it is
 * what a `WorkflowEntrypoint` is generic over and what the platform actually binds.
 */
export interface EmailWorkerEnv extends SecretsStoreEnv {
  /** The app database the per-environment jobs/events tables live in. */
  DB: D1Database;
  /** The link-signing key: this environment's Secrets Store entry, or its `.dev.vars` string locally (#596). */
  [EMAIL_LINK_SIGNING_KEY_BINDING]: SecretBinding | string;
  /** The shared, durable suppression database. */
  EMAIL_SUPPRESSIONS: D1Database;
  /** The Cloudflare Email Service send binding. */
  EMAIL: EmailSender;
  /** The send Workflow (self) — the scheduler creates batches against it, and asks after them. */
  EMAIL_SENDER: SendWorkflowBinding & SendWorkflowInstances;
  /** The scheduler Workflow (self) — fired by the cron. */
  EMAIL_SCHEDULER: { create(): Promise<unknown> };
  /** The resolved brand theme as a JSON string (the full `EmailTheme`), set at provision from the app config. */
  EMAIL_THEME?: string;
  /**
   * The project's catalogs arrive as one variable per locale — `EMAIL_MESSAGES_ES` and friends — read
   * through `catalogsFromEnv`. Not declared here, because the names are the project's locales.
   */
  [catalogVar: `EMAIL_MESSAGES_${string}`]: unknown;
  BASE_URL: string;
  // ENVIRONMENT is inherited from SecretsStoreEnv (a `ManagedEnvironment`); never redeclare it as a plain string.
  LINK_TTL_DAYS?: string;
  MAX_ATTEMPTS?: string;
  SCHEDULER_ENABLED?: string;
  SCHEDULER_BATCH_SIZE?: string;
  SCHEDULER_MAX_JOBS?: string;
  SCHEDULER_GRACE_MS?: string;
  SCHEDULER_STUCK_MS?: string;
}

// This is a standalone worker, not assembled by `createBackend`, so the secrets capability's `compose`
// hook never runs here. Configure the shared per-invocation accessor directly from email's own slice so
// `resolveSigningKeys` reads the signing key through the one cached path.
configureSharedSecrets({ registry: emailSigningRegistry });

/**
 * The env, parsed — or one legible block naming every unusable setting and what fills it, then a
 * refusal. Called at the top of every entry, and the block is written once per env object.
 */
export function hostConfig(env: EmailWorkerEnv): EmailHostEnv {
  return requireHostEnv(emailHostEnv, env);
}

/**
 * Assemble the send dependencies, resolving the current signing key from the secrets store.
 *
 * Here rather than in `worker.ts`, which imports `cloudflare:workers` and so loads in workerd alone: this is the
 * host's whole reading of its env for a send, and a test that drives a send the way the deployed host would —
 * the feature sign-in end to end, #643 — has to read it through this function, not a copy of it.
 */
export async function buildSendDeps(env: EmailWorkerEnv): Promise<SendBatchDeps> {
  const config = hostConfig(env);
  const keys = await resolveSigningKeys(env);
  const key = keys.versions[keys.currentVersion];
  return {
    db: emailDatabase(env.DB),
    suppressionDb: emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
    sender: env.EMAIL,
    theme: config.EMAIL_THEME,
    // The catalogs, as a seam over the one JSON var. A body renders in the job's own locale from here;
    // with the var absent this resolves to the kit's English, unchanged from before #441.
    layersFor: catalogLayers(catalogsFromEnv(env as unknown as Record<string, unknown>)),
    baseUrl: config.BASE_URL,
    signing: key ? { key, kid: keys.currentVersion } : undefined,
    linkTtlDays: config.LINK_TTL_DAYS,
    maxAttempts: config.MAX_ATTEMPTS,
    environment: config.ENVIRONMENT,
    heartbeatAt: () => new Date(),
  };
}
