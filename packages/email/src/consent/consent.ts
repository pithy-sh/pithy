// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import type { ConsentPurpose } from "@pithy-sh/core/src/consent/purpose";
import type { ConsentGrant, ConsentReader, ConsentSubject, ConsentWithdrawal } from "@pithy-sh/core/src/consent/reader";
import { SQLiteBoolean, SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";

/**
 * Email under consent.
 *
 * Email does two things a law may require consent for: it tracks opens and clicks, and it sends marketing mail. It
 * declares each as a purpose, and when `@pithy-sh/consent` is composed it asks before doing either. Transactional
 * mail is never gated: a sign-in link answers something the person just did. Without consent composed, email
 * behaves exactly as it did before, and `pithy doctor` names that tracking runs with no consent record behind it.
 */

/** Marketing mail: a template whose category is `marketing`. */
export const EMAIL_MARKETING_PURPOSE = "email.marketing";

/** Open and click tracking, on any template that would track. */
export const EMAIL_TRACKING_PURPOSE = "email.tracking";

/** The purposes email declares. Version 1 of each; a change to what they allow is a version bump here. */
export const EMAIL_CONSENT_PURPOSES: readonly ConsentPurpose[] = [
  {
    id: EMAIL_MARKETING_PURPOSE,
    summary: "Send me news and offers by email.",
    noticeVersion: 1,
    classes: ["pii"],
    explicit: false,
    minimumMethod: "click",
    writtenWithdrawal: false,
  },
  {
    id: EMAIL_TRACKING_PURPOSE,
    summary: "Tell the sender when I open their email or follow a link in it.",
    noticeVersion: 1,
    classes: ["pii"],
    explicit: false,
    minimumMethod: "click",
    writtenWithdrawal: false,
  },
];

/** What the consent gate decided for one enqueue. */
export interface ConsentGate {
  /** The purpose that withholds the message, or `null` when it may be sent. */
  readonly withheld: string | null;
  /** Whether open and click tracking may run. */
  readonly tracking: boolean;
}

/** Ungated: no consent capability is composed, so email behaves as it always has. */
const UNGATED: ConsentGate = { withheld: null, tracking: true };

/**
 * Decide, for one message, what consent allows. With no reader, nothing is gated. With one, a marketing message
 * needs the subject's consent to `email.marketing` and tracking needs `email.tracking`; a message with no subject
 * has nobody whose consent could be shown, so it is withheld if marketing and untracked either way. Transactional
 * mail is never withheld.
 */
export async function consentGate(
  reader: ConsentReader | null | undefined,
  subject: ConsentSubject | undefined,
  marketing: boolean,
): Promise<ConsentGate> {
  if (!reader) return UNGATED;
  const holds = async (purpose: string) => subject !== undefined && (await reader.hasConsent(subject, purpose));
  const withheld = marketing && !(await holds(EMAIL_MARKETING_PURPOSE)) ? EMAIL_MARKETING_PURPOSE : null;
  return { withheld, tracking: await holds(EMAIL_TRACKING_PURPOSE) };
}

/** The detail a withdrawal's suppression carries — and the only suppression a later grant lifts. */
const WITHDRAWAL_DETAIL = `consent withdrawn: ${EMAIL_MARKETING_PURPOSE}`;

/** The bindings the listener writes through. */
function bindingOf(env: Record<string, unknown>, name: string): D1Database | undefined {
  const binding = env[name];
  return typeof binding === "object" && binding !== null ? (binding as D1Database) : undefined;
}

/**
 * Keep email in step with a withdrawal.
 *
 * - **`email.marketing`**: the address is suppressed for marketing — an `unsubscribe`, which blocks elective mail
 *   and never a sign-in link — so the suppression list and the consent record never disagree. The suppression it
 *   leaves is permanent, because it is what holds a message already scheduled. An address already suppressed for
 *   good keeps its row: a hard bounce is stronger than an unsubscribe and is never downgraded. A time-boxed row is
 *   not left to expire under the withdrawal: a lapsed one, or a live time-boxed unsubscribe, is replaced by the
 *   withdrawal's own; a live time-boxed bounce, complaint or manual keeps its reason and becomes permanent.
 * - **`email.tracking`**: mail already queued to the address stops tracking. It was decided at enqueue, and the
 *   person has since said no.
 *
 * A visitor has no address to act on; their next enqueue is gated by the record instead.
 */
export async function emailConsentWithdrawn(withdrawal: ConsentWithdrawal): Promise<void> {
  const address = await withdrawal.address();
  if (address === null) return;
  const now = new Date();
  if (withdrawal.purpose === EMAIL_MARKETING_PURPOSE) {
    const suppressions = bindingOf(withdrawal.env, "EMAIL_SUPPRESSIONS");
    if (!suppressions) return;
    await emailSuppressionDatabase(suppressions)
      .insertInto("pithyEmailSuppressions")
      .values({
        email: normalizeAddress(address),
        reason: "unsubscribe",
        jobId: null,
        environment: null,
        detail: WITHDRAWAL_DETAIL,
        expiresAt: null,
        createdAt: SQLiteDate.encode(now),
      })
      .onConflict((conflict) =>
        conflict
          .column("email")
          .doUpdateSet((eb) => {
            // The withdrawal takes the row when nothing stronger stands in it: the row has lapsed, or it is a
            // time-boxed unsubscribe. A live time-boxed bounce, complaint or manual keeps its reason and its detail,
            // and loses only its expiry, so it never weakens and the withdrawal never lapses with it.
            const takes = eb.or([
              eb("pithyEmailSuppressions.expiresAt", "<=", SQLiteDate.encode(now)),
              eb("pithyEmailSuppressions.reason", "=", "unsubscribe"),
            ]);
            return {
              reason: eb
                .case()
                .when(takes)
                .then("unsubscribe" as const)
                .else(eb.ref("pithyEmailSuppressions.reason"))
                .end(),
              detail: eb.case().when(takes).then(WITHDRAWAL_DETAIL).else(eb.ref("pithyEmailSuppressions.detail")).end(),
              jobId: eb.case().when(takes).then(null).else(eb.ref("pithyEmailSuppressions.jobId")).end(),
              environment: eb.case().when(takes).then(null).else(eb.ref("pithyEmailSuppressions.environment")).end(),
              expiresAt: null,
            };
          })
          // A permanent row already blocks marketing for good, whatever its reason, so it is never touched.
          .where("pithyEmailSuppressions.expiresAt", "is not", null),
      )
      .execute();
    return;
  }
  if (withdrawal.purpose === EMAIL_TRACKING_PURPOSE) {
    const db = bindingOf(withdrawal.env, "DB");
    if (!db) return;
    await emailDatabase(db)
      .updateTable("pithyEmailJobs")
      .set({
        openTracking: SQLiteBoolean.encode(false),
        clickTracking: SQLiteBoolean.encode(false),
        updatedAt: SQLiteDate.encode(now),
      })
      .where("recipientKey", "=", normalizeAddress(address))
      .where("status", "in", ["pending", "scheduled", "undispatched"])
      .execute();
  }
}

/**
 * Keep email in step with a grant: the other half of {@link emailConsentWithdrawn}.
 *
 * Granting `email.marketing` again lifts the suppression a withdrawal wrote — an `unsubscribe` whose detail is the
 * withdrawal's own sentence — so the person's yes is heard. Nothing else is ever lifted: a bounce, a complaint, an
 * unsubscribe from a mail's own link, and an operator's manual suppression all stand, because none of them was the
 * consent record's to begin with.
 */
export async function emailConsentGranted(grant: ConsentGrant): Promise<void> {
  if (grant.purpose !== EMAIL_MARKETING_PURPOSE) return;
  const address = await grant.address();
  if (address === null) return;
  const suppressions = bindingOf(grant.env, "EMAIL_SUPPRESSIONS");
  if (!suppressions) return;
  await emailSuppressionDatabase(suppressions)
    .deleteFrom("pithyEmailSuppressions")
    .where("email", "=", normalizeAddress(address))
    .where("reason", "=", "unsubscribe")
    .where("detail", "=", WITHDRAWAL_DETAIL)
    .execute();
}
