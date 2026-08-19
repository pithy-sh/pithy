// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { fromZodError, InternalError, messageOf } from "@pithy-sh/core/src/error/pithyError";
import type { SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { PaymentsConfig } from "../config/config";

/**
 * The reconcile worker's env, and the one function that reads its config out of a var.
 *
 * **A sibling module rather than part of `worker.ts`, and the split is a rule rather than a preference.**
 * `worker.ts` imports `cloudflare:workers`, so it resolves only inside the Workers runtime — and anything it
 * exports is therefore unreachable from a node test, from the CLI, and from every meta-test that walks this
 * repository's exports. `packages/cli/src/capabilities/configEntrypoints.test.ts` fails a runtime module that
 * exports a pure value for exactly that reason (#172), and this function is a pure value: it takes a plain
 * object and returns a parsed config, touching no binding and no runtime API.
 *
 * So it lives here, where anything may import it, and `worker.ts` imports it like any other caller.
 */

/** The reconcile worker's env: the app database, the secrets database, the master key, and its config. */
export interface PaymentsWorkerEnv extends SecretsStoreEnv {
  /** The app database the `pithy_payments_*` tables live in. */
  DB: D1Database;
  /** The resolved payments config as a JSON string, filled at provision. See {@link reconcileWorkerConfig}. */
  PAYMENTS_CONFIG?: string;
  /** This worker's own Workflow binding — how `scheduled()` starts an instance. */
  PAYMENTS_RECONCILE?: { create(options?: { id?: string; params?: unknown }): Promise<unknown> };
}

/**
 * The catalog this worker reconciles against, read back out of the `PAYMENTS_CONFIG` var.
 *
 * **A config this does not accept stops the run, and since `billingSubject` became required that includes
 * an absent var.** It used to fall back to `{}` and every default — which was survivable while every field
 * had one, and is not now. The holder kind is the one thing a pass cannot default: `user` is what a
 * defaulted config would produce, and a pass that repaired an organization's subscriptions while believing
 * it was reconciling users would resolve entitlements for the wrong holder and audit the repairs under it.
 * Refusing is the loud version of the same fact, and it fires on the first cron rather than on the first
 * support ticket.
 *
 * Named as a refusal rather than a stack trace, because the reader is an operator: the message says which
 * var, the action says which command rewrites it. Both `PithyError`s, so the Workflow's failure reads the
 * way every other failure in the kit does.
 */
export function reconcileWorkerConfig(env: PaymentsWorkerEnv): PaymentsConfig {
  let value: unknown;
  try {
    // An empty var is absent, not malformed — a wrangler config with the key and no value is the same
    // missing config as one without the key, and it deserves the refusal that names the missing key rather
    // than one about JSON syntax.
    value = env.PAYMENTS_CONFIG ? JSON.parse(env.PAYMENTS_CONFIG) : undefined;
  } catch (cause) {
    throw new InternalError({
      message: "The reconcile worker's PAYMENTS_CONFIG var is not valid JSON.",
      action: "Re-run `pithy payments provision` for this environment to rewrite it.",
      detail: messageOf(cause),
    });
  }

  const parsed = PaymentsConfig.safeParse(value ?? {});
  if (!parsed.success) {
    throw fromZodError(parsed.error, {
      message: "The reconcile worker's PAYMENTS_CONFIG var is not a payments config this build can run.",
      // The two halves of the repair, in the order they have to happen: the value is the adopter's, and the
      // var is a copy of it. Fixing only the second is a provision that writes the same refusal back.
      action:
        "Set the missing keys in this Worker's pithy.config.ts — `billingSubject` is required — then re-run `pithy payments provision` for this environment.",
    });
  }
  return parsed.data;
}
