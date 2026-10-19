// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { composedCapability } from "@pithy-sh/core/src/capability/composition";
import { bindWorkflowContext, createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import {
  classifiedSteps,
  type TerminalErrorConstructor,
  type WorkflowStepLike,
} from "@pithy-sh/core/src/workflow/faults";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { sharedSecretsStore } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { isPaymentsCapability, type PaymentsCapability } from "../capability";
import { paddleUsageReporter } from "../rails/paddle/usage";
import { stripeUsageReporter } from "../rails/stripe/usage";
import { PAYMENTS_PROVIDER_SECRET, paymentsSecretsRegistry } from "../secret/registry";
import { runUsageReport, type UsagePassTally } from "../usage/pass";
import type { UsageReporter } from "../usage/reporter";
import { paymentsWorkflowRetry } from "./retryPolicy";
import { PaymentsUsageParams } from "./specs";

/**
 * The usage-reporting Workflow's body — run by a class **the adopter's own Worker** exports, because it calls
 * their `resolveQuantity` and that function exists nowhere else.
 *
 *   // apps/api/src/index.ts, beside the `createEntrypoint` it already exports
 *   import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
 *   import { NonRetryableError } from "cloudflare:workflows";
 *   import { reportPaymentsUsage } from "@pithy-sh/payments/src/workflows/usage";
 *
 *   export class PaymentsUsageWorkflow extends WorkflowEntrypoint<Record<string, unknown>> {
 *     override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
 *       return reportPaymentsUsage(this.env, event, step, NonRetryableError);
 *     }
 *   }
 *
 * plus a `workflows` entry binding `PAYMENTS_USAGE` to that class and the spec's cron —
 * `packages/payments/docs/entitlements.md` has the stanza. **The class is the adopter's, the body is the
 * kit's**, which is the split every app-declared Workflow already has: Cloudflare resolves a `class_name` in
 * the script that binds it, so the class must be exported from the app's own entry, and a class shipped here
 * would be one more module the build reads as a Workflow host it is not.
 *
 * The body finds the composed payments capability the way a Workflow that sends mail finds the composed email
 * one: the class is exported from the same entry that calls `createBackend`, so the composition has happened
 * in this isolate, and `resolveQuantity` is on the capability, never in a config that crossed a var.
 *
 * One journalled step. The pass is idempotent end to end — every period has one row, claimed before the store
 * is called, and the row id is the store's idempotency key — so a retried step reports nothing twice.
 */
export async function reportPaymentsUsage(
  env: Record<string, unknown>,
  event: { payload?: unknown; workflowName?: string; instanceId?: string },
  step: WorkflowStepLike,
  terminalError: TerminalErrorConstructor,
): Promise<UsagePassTally | null> {
  PaymentsUsageParams.parse(event.payload ?? {});
  const log = bindWorkflowContext(createWorkerLogger({ name: "payments:usage" }), {
    workflow: event.workflowName ?? "payments-usage",
    instance: event.instanceId ?? "unknown",
    env: typeof env.ENVIRONMENT === "string" ? env.ENVIRONMENT : "unknown",
  });
  const payments = composedCapability<PaymentsCapability>("payments", isPaymentsCapability);
  const usage = payments.paymentsUsage;
  if (usage === undefined) {
    log.warn("usage reporting has no resolver; nothing reported");
    return null;
  }
  const config = payments.paymentsConfig;

  // Classified like every payments step: a store that could not be reached re-drives it, and anything else
  // fails it at once rather than spending a retry budget on an answer that will not change.
  const steps = classifiedSteps(step, paymentsWorkflowRetry, terminalError);
  return steps.do("report usage", async () => {
    const secrets = await sharedSecretsStore(env as unknown as SecretsStoreEnv, paymentsSecretsRegistry);
    const credentials = secrets.get(PAYMENTS_PROVIDER_SECRET);
    const reporters: Partial<Record<"stripe" | "paddle", UsageReporter>> = {};
    if (credentials.stripe !== undefined) {
      reporters.stripe = stripeUsageReporter({ secretKey: credentials.stripe.secretKey });
    }
    if (credentials.paddle !== undefined && config.paddle !== undefined) {
      reporters.paddle = paddleUsageReporter({
        apiKey: credentials.paddle.apiKey,
        environment: config.paddle.environment,
      });
    }
    return runUsageReport({
      d1: env.DB as D1Database,
      config,
      resolveQuantity: usage.resolveQuantity,
      reporters,
      env,
      now: () => new Date(),
      log,
    });
  });
}
