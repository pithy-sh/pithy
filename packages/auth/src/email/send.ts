// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { EmailCapability } from "@pithy-sh/email/src/capability";
import type { AuthEmailMessage, SendAuthEmail } from "../instance/auth";

/**
 * The email-delivery seam. Auth never assembles the email infrastructure — it calls the `enqueue` the
 * email capability exposes (already bound to the request env by the caller), passing only the
 * high-level input. The email capability owns the `DB`/`EMAIL_SENDER` bindings, the from-identity, and
 * the theme. Delivery is the email Workflow's job; auth only enqueues.
 */

/** An env-bound enqueue — the email capability's `enqueue`, partially applied with the request env. */
export type EnqueueEmail = (input: Parameters<EmailCapability["enqueue"]>[1]) => Promise<unknown>;

/** Build the `sendEmail` the auth instance calls from its magic-link / OTP hooks. */
export function makeSendAuthEmail(enqueue: EnqueueEmail, expiresMinutes: number): SendAuthEmail {
  return async (message: AuthEmailMessage): Promise<void> => {
    if (message.template === "magicLink") {
      await enqueue({ to: message.to, template: "magicLink", payload: { url: message.url, expiresMinutes } });
      return;
    }
    await enqueue({ to: message.to, template: "otp", payload: { code: message.code, expiresMinutes } });
  };
}
