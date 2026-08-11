// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";

/**
 * The closed enums of the email capability. Each is the documented vocabulary for one column, shared
 * across the row schemas, the send path, and the callback/bounce handlers. Stored as text in SQLite.
 */

export const TemplateCategory = z
  .enum(["transactional", "marketing"])
  .describe(
    "What a template's message *is*. `transactional` is triggered by a user action (magic link, receipt); `marketing` is promotional, and cannot render at all without an unsubscribe link. The category drives tracking defaults and that hard requirement. Whether a person may *refuse* the message is a separate question, answered by `EmailKind` — a testing-programme nudge is transactional in style and elective in consent.",
  );
export type TemplateCategory = z.output<typeof TemplateCategory>;

export const EmailKind = z
  .enum(["transactional", "elective"])
  .describe(
    "Whether a recipient may refuse a message. `transactional` answers something the person just did — a sign-in link, an invitation they are waiting on, a security notice — and carries no unsubscribe affordance and no `List-Unsubscribe` header; `elective` is mail somebody chose to receive and carries both. The kind is declared by the template, never passed by a caller, and it decides how the suppression list is consulted: an unsubscribe blocks elective mail only, while a bounce or a complaint blocks everything.",
  );
export type EmailKind = z.output<typeof EmailKind>;

export const SendMode = z
  .enum(["immediate", "scheduled", "timezone"])
  .describe(
    "How a job's send time is determined. `immediate` sends now (a Workflow starts at enqueue); `scheduled` sends at a fixed absolute time; `timezone` resolves a recipient's local time-of-day to an absolute time using their IANA zone.",
  );
export type SendMode = z.output<typeof SendMode>;

export const EmailJobStatus = z
  .enum(["pending", "scheduled", "sending", "sent", "failed", "suppressed", "bounced", "cancelled"])
  .describe(
    "The lifecycle state of an email job. `pending` (immediate, awaiting dispatch) and `scheduled` (future sendAt) are pre-send; `sending` is in-flight; `sent` succeeded; `failed` exhausted retries; `suppressed` was skipped because the address is on the suppression list; `bounced` was reported undeliverable; `cancelled` was withdrawn before sending.",
  );
export type EmailJobStatus = z.output<typeof EmailJobStatus>;

export const EmailEventType = z
  .enum(["sent", "open", "click", "bounce", "complaint", "unsubscribe", "suppressed", "failed"])
  .describe(
    "A per-recipient event recorded for history and campaign attribution: `sent` on a successful send, `open` from the tracking pixel, `click` from a tracked link, `bounce`/`complaint` from inbound mail, `unsubscribe` from the opt-out callback, `suppressed` when a send was skipped, `failed` on a terminal send error.",
  );
export type EmailEventType = z.output<typeof EmailEventType>;

export const BounceType = z
  .enum(["hard", "soft", "complaint", "auto_reply"])
  .describe(
    "How an inbound delivery-status or complaint message was classified: `hard` (permanent — suppress), `soft` (transient — Cloudflare auto-retries), `complaint` (recipient reported spam — suppress), `auto_reply` (vacation responder — a no-op, never suppressed).",
  );
export type BounceType = z.output<typeof BounceType>;

export const SuppressionReason = z
  .enum(["hard_bounce", "complaint", "unsubscribe", "manual"])
  .describe(
    "Why an address is on the suppression list and will not be sent to: `hard_bounce` (permanent delivery failure), `complaint` (spam report), `unsubscribe` (recipient opted out), `manual` (added by an operator).",
  );
export type SuppressionReason = z.output<typeof SuppressionReason>;
