// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { EmailCapability } from "@pithy-sh/email/src/capability";
import type { EnqueueResult } from "@pithy-sh/email/src/send/enqueue";
import type { AuthEmailDelivery } from "../audit/evidence";
import type { AuthEmailMessage, SendAuthEmail } from "../instance/auth";

/**
 * The email-delivery seam. Auth never assembles the email infrastructure — it calls the `enqueue` the
 * email capability exposes (already bound to the request env by the caller), passing only the
 * high-level input. The email capability owns the `DB`/`EMAIL_SENDER` bindings, the from-identity, and
 * the theme. Delivery is the email Workflow's job; auth only enqueues.
 */

/**
 * An env-bound enqueue — the email capability's `enqueue`, partially applied with the request env.
 *
 * **Its result is the point, and it used to be `unknown`.** The capability answers with the job id, the
 * status the row was born with and, where it withheld the message, the reason — which is the only place
 * anything knows whether a send is coming. Thrown away, the two audit events that claim a message had
 * nothing left to read but the fact that this function was called (#627).
 */
export type EnqueueEmail = (input: Parameters<EmailCapability["enqueue"]>[1]) => Promise<EnqueueResult>;

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
  return async (message: AuthEmailMessage): Promise<AuthEmailDelivery> => {
    const locale = (await localeFor?.(message.to)) ?? undefined;
    if (message.template === "magicLink") {
      return deliveryOf(
        await enqueue({
          to: message.to,
          template: "magicLink",
          payload: { url: message.url, expiresMinutes },
          ...(locale ? { locale } : {}),
        }),
      );
    }
    return deliveryOf(
      await enqueue({
        to: message.to,
        template: "otp",
        payload: { code: message.code, expiresMinutes },
        ...(locale ? { locale } : {}),
      }),
    );
  };
}

/**
 * What one enqueue means for the trail — the translation from the email capability's vocabulary into
 * `auth`'s.
 *
 * **`suppressed` is the only status that is not a send.** The capability consulted the global suppression
 * list, withheld the message and started nothing; the row it wrote exists so an operator can see the
 * withholding, not because anything is coming for it. The reason rides along because "suppressed" alone
 * does not tell anybody whether the mailbox is dead, the person complained, or an operator did it by
 * hand — and those are three different next moves. `suppressionReason` is optional on the result, so its
 * absence falls back to the status itself rather than to a fabricated reason.
 *
 * **`undispatched` is a send, deliberately.** It means this composition binds no send Workflow yet, so
 * nothing was *started* — but the job row exists and the scheduler drains those the day a host is
 * deployed (pithy-sh/pithy#410). `auth/otp_sent` claims a message was enqueued for delivery, which is
 * exactly what happened; the deployment gap is the email capability's own channel to report, and
 * recording it here as a decline would put "this deployment is incomplete" in a column an abuse count is
 * read from.
 */
function deliveryOf(result: EnqueueResult): AuthEmailDelivery {
  if (result.status === "suppressed") {
    return { delivery: "withheld", reason: result.suppressionReason ?? result.status };
  }
  return { delivery: "queued" };
}
