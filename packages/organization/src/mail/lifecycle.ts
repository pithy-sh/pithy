// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { formattingLocaleOf } from "@pithy-sh/core/src/i18n/locale";
import type { OrganizationConfig } from "../config/config";
import type { EnqueueInvitation } from "./invitation";
import type { NoticeRecipient } from "./membership";

/**
 * The three notices an organization's owners get when an operator acts on the organization itself (#623): it was
 * suspended, it was reinstated, or it was deleted and will be erased on a date.
 *
 * **Through the kit's own templates in `@pithy-sh/email`, through the enqueue seam the invitation uses**, so
 * email stays an optional peer. Each is switchable off (`lifecycleEmails`), and all three send by default.
 *
 * **The suspension carries the operator's reason, unlike the membership notices.** The suspended screen tells
 * every member that the owners were told why, so the owners are told why: it is the one sentence they need to
 * get the organization back. **A notice that cannot be sent never undoes the act it reports**: by the time one
 * is enqueued the organization has already moved, so a missing seam or an enqueue that throws is reported as
 * not sent and nothing else.
 */

/** Which notice, by the config key that switches it off. */
export type LifecycleNotice = keyof OrganizationConfig["lifecycleEmails"];

/** The kit template each notice renders through, named once. */
export const LIFECYCLE_NOTICE_TEMPLATES: Readonly<Record<LifecycleNotice, string>> = {
  organizationSuspended: "organizationSuspended",
  organizationReinstated: "organizationReinstated",
  organizationDeletionScheduled: "organizationDeletionScheduled",
};

/** What one notice says. */
export interface LifecycleNoticeMail {
  /** Which notice. */
  readonly notice: LifecycleNotice;
  /** Who it goes to: one owner. */
  readonly to: NoticeRecipient;
  /** The organization, by display name. Tenant text; the template escapes it. */
  readonly organizationName: string;
  /** For a suspension, the operator's reason. */
  readonly reason?: string;
  /** For a suspension, when it ends by itself. */
  readonly until?: Date | null;
  /** For a deletion, when the organization's data is erased. */
  readonly purgeOn?: Date;
}

/** A date written for its reader, in their language — the shape every lifecycle mail carries its dates in. */
export function readableDate(date: Date, locale: string | null | undefined): string {
  const tag = (locale ? formattingLocaleOf(locale) : null) ?? "en";
  return new Intl.DateTimeFormat(tag, { dateStyle: "long", timeZone: "UTC" }).format(date);
}

/**
 * Enqueue one notice, when the config sends it and a seam exists to send it through. Answers with the enqueue's
 * own status, or null when nothing was enqueued. Never throws.
 */
export async function sendLifecycleNotice(
  config: Pick<OrganizationConfig, "lifecycleEmails">,
  enqueue: EnqueueInvitation | undefined,
  mail: LifecycleNoticeMail,
): Promise<string | null> {
  if (!config.lifecycleEmails[mail.notice] || !enqueue) return null;
  const name = mail.to.name?.trim();
  const locale = mail.to.locale ?? null;
  const payload: Record<string, unknown> = {
    organizationName: mail.organizationName,
    ...(name ? { name } : {}),
    ...(mail.notice === "organizationSuspended" && mail.reason ? { reason: mail.reason } : {}),
    ...(mail.notice === "organizationSuspended" && mail.until ? { until: readableDate(mail.until, locale) } : {}),
    ...(mail.notice === "organizationDeletionScheduled" && mail.purgeOn
      ? { purgeOn: readableDate(mail.purgeOn, locale) }
      : {}),
  };
  try {
    const result = await enqueue({
      to: mail.to.email,
      template: LIFECYCLE_NOTICE_TEMPLATES[mail.notice],
      payload,
      ...(locale ? { locale } : {}),
    });
    return result.status;
  } catch {
    // The act already happened. A notice that could not be queued is reported as not sent.
    return null;
  }
}

/**
 * Send one notice to every owner, and say how many were queued — or null when none could be, which is what the
 * audit event records as `mailed`.
 */
export async function notifyOwners(
  config: Pick<OrganizationConfig, "lifecycleEmails">,
  enqueue: EnqueueInvitation | undefined,
  owners: readonly NoticeRecipient[],
  mail: Omit<LifecycleNoticeMail, "to">,
): Promise<number | null> {
  if (!config.lifecycleEmails[mail.notice] || !enqueue) return null;
  let queued = 0;
  for (const owner of owners) {
    if ((await sendLifecycleNotice(config, enqueue, { ...mail, to: owner })) !== null) queued += 1;
  }
  return queued;
}
