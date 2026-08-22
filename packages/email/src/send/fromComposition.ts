// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { composedCapability } from "@pithy-sh/core/src/capability/composition";
import { type EmailCapability, type EmailEnqueueEnv, isEmailCapability } from "../capability";
import type { EnqueueInput, EnqueueResult } from "./enqueue";

/**
 * Sending mail from a Workflow (pithy-sh/pithy#356).
 *
 * A route reaches `enqueue` through the `compose` hook, and should keep doing that — it is typed, it is
 * explicit, and it does not depend on module load order. **A Workflow class has no such route.** The
 * runtime constructs it with the worker `env` and nothing else, `enqueue` is a closure rather than a
 * binding, and Workflow params are serialized so a closure cannot travel in one either. Until this
 * existed, a durable job could not send mail without rebuilding the sending identity from `env` — the
 * same from-address in a second place, free to drift from `pithy.config.ts` — which is exactly what this
 * capability's own doc asks consumers not to do.
 *
 * So: one function, taking the env a Workflow already has, restating nothing.
 *
 * ```ts
 * export class RotationWorkflow extends WorkflowEntrypoint<Env, RotationParams> {
 *   override async run(event: WorkflowEvent<RotationParams>, step: WorkflowStep) {
 *     await step.do("notify", async () => {
 *       await enqueueFromEnv(this.env, { to, template: "operationalNotice", payload });
 *     });
 *   }
 * }
 * ```
 *
 * The Workflow class must be exported from the same worker entrypoint that calls `createBackend` —
 * which Cloudflare requires anyway — so the composition has already happened in this isolate by the time
 * a step body runs. Where it has not, this raises a wiring fault naming what to compose rather than
 * sending mail as some invented identity.
 */

/**
 * The composed email capability, or a raised wiring fault.
 *
 * Narrowed by `isEmailCapability`, the capability's own guard, so a capability composed under the name
 * `email` but carrying no seams is caught here rather than at a call site whose `enqueue` is undefined.
 */
export function composedEmail(): EmailCapability {
  return composedCapability<EmailCapability>("email", isEmailCapability);
}

/**
 * Enqueue an email from a worker env alone — the seam a Workflow step uses.
 *
 * Identical in every respect to `EmailCapability.enqueue`, because it *is* that function: the
 * from-identity, the theme, the bindings and the automatic suppression check (pithy-sh/pithy#355) all
 * come from the one composed capability. Nothing about a durable send differs from a request-time one
 * except how the caller got here.
 */
export function enqueueFromEnv(env: EmailEnqueueEnv, input: EnqueueInput): Promise<EnqueueResult> {
  return composedEmail().enqueue(env, input);
}
