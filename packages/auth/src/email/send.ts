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

/**
 * The language to write to this person in, resolved per message.
 *
 * A thunk over the address rather than a value, because the answer is a database read and most of
 * what it is asked about is a sign-in that may not have an account yet. See {@link makeSendAuthEmail}.
 */
export type ResolveRecipientLocale = (email: string) => Promise<string | null>;

/**
 * Build the `sendEmail` the auth instance calls from its magic-link / OTP hooks.
 *
 * ## The locale
 *
 * A sign-in email is the first thing a project sends and the one it cannot afford to send in a
 * language the reader does not have, because there is no password to fall back to: somebody who cannot
 * find the button in an unfamiliar alphabet cannot get in at all. So `localeFor` is asked per message
 * and the answer rides onto the job, where the send Workflow reads it back hours later.
 *
 * It resolves in two steps and the order matters. **A stored `pithy_auth_users.locale` wins**, because
 * a person who has chosen a language has said something durable about themselves, and the device they
 * happen to be signing in from tonight has not. Where there is no row — a first-time sign-up, which is
 * exactly when a magic link matters most — the resolver falls back to the language this request
 * negotiated, which is the only thing anyone knows about the reader yet. Null means neither answered,
 * and null renders the kit's English rather than asserting English was chosen.
 *
 * Optional so that a composition without it (and every existing test harness) behaves as it did.
 */
export function makeSendAuthEmail(
  enqueue: EnqueueEmail,
  expiresMinutes: number,
  localeFor?: ResolveRecipientLocale,
): SendAuthEmail {
  return async (message: AuthEmailMessage): Promise<void> => {
    const locale = (await localeFor?.(message.to)) ?? undefined;
    if (message.template === "magicLink") {
      await enqueue({
        to: message.to,
        template: "magicLink",
        payload: { url: message.url, expiresMinutes },
        ...(locale ? { locale } : {}),
      });
      return;
    }
    await enqueue({
      to: message.to,
      template: "otp",
      payload: { code: message.code, expiresMinutes },
      ...(locale ? { locale } : {}),
    });
  };
}
