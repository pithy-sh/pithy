// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { OrganizationConfig } from "../config/config";
import type { EnqueueInvitation } from "./invitation";

/**
 * The three notices an operator's act sends (#624): somebody was added to an account, removed from one,
 * or made its owner.
 *
 * **Through the kit's own templates in `@pithy-sh/email`, and through the same enqueue seam the
 * invitation uses** — a function handed in, never an import, so email stays an optional peer of this
 * package. `./invitation.ts` argues the seam at length.
 *
 * **Each is switchable off, and all three send by default** (`operatorEmails` in the config). A person
 * whose access to an account was changed by somebody else is owed the word; a project that tells them
 * some other way turns the mail off rather than sending two.
 *
 * **A notice that cannot be sent never undoes the act it reports.** By the time one is enqueued the
 * membership has already changed, so a Worker with no email composed sends nothing and the audit event
 * says `mailed: null`, and an enqueue that throws is swallowed and reported the same way. That is the
 * difference from the invitation, which refuses up front: an invitation that is not sent is a live
 * token nobody receives, and a notice that is not sent is a sentence nobody reads.
 *
 * **The operator's reason is not in the mail.** It is the trail's, written for whoever answers for the
 * account, and it can say things about the person — *left the company*, *chargeback* — that are not a
 * sentence to send them.
 */

/** Which notice, by the config key that switches it off. */
export type MembershipNotice = keyof OrganizationConfig["operatorEmails"];

/** The kit template each notice renders through, named once. */
export const MEMBERSHIP_NOTICE_TEMPLATES: Readonly<Record<MembershipNotice, string>> = {
  memberAdded: "organizationMemberAdded",
  memberRemoved: "organizationMemberRemoved",
  ownershipTransferred: "organizationOwnershipTransferred",
};

/** Who a notice goes to, as the auth capability's own reader resolved them. */
export interface NoticeRecipient {
  /** Their address. */
  readonly email: string;
  /** What they call themselves, when they said. */
  readonly name?: string | null;
  /** Their chosen language, when they chose one. */
  readonly locale?: string | null;
}

/** What one notice says. */
export interface MembershipNoticeMail {
  /** Which notice. */
  readonly notice: MembershipNotice;
  /** Who it goes to. */
  readonly to: NoticeRecipient;
  /** The organization, by display name. Tenant text; the template escapes it. */
  readonly organizationName: string;
  /** The role they hold now. Only the `memberAdded` notice says it. */
  readonly role?: string;
}

/**
 * Enqueue one notice, when the config sends it and a seam exists to send it through.
 *
 * Answers with the enqueue's own status — `queued`, `suppressed`, and so on — or null when nothing was
 * enqueued, which is what the audit event records as `mailed`. Never throws.
 */
export async function sendMembershipNotice(
  config: Pick<OrganizationConfig, "operatorEmails">,
  enqueue: EnqueueInvitation | undefined,
  mail: MembershipNoticeMail,
): Promise<string | null> {
  if (!config.operatorEmails[mail.notice] || !enqueue) return null;
  const name = mail.to.name?.trim();
  const payload: Record<string, unknown> = {
    organizationName: mail.organizationName,
    ...(name ? { name } : {}),
    ...(mail.notice === "memberAdded" && mail.role !== undefined ? { role: mail.role } : {}),
  };
  try {
    const result = await enqueue({
      to: mail.to.email,
      template: MEMBERSHIP_NOTICE_TEMPLATES[mail.notice],
      payload,
      ...(mail.to.locale ? { locale: mail.to.locale } : {}),
    });
    return result.status;
  } catch {
    // The act already happened. A notice that could not be queued is reported as not sent.
    return null;
  }
}
