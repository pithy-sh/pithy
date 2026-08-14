// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { EmailJob } from "../data/emailJob";
import { EmailJob as EmailJobSchema } from "../data/emailJob";
import type { EmailJobStatus, SendMode } from "../data/enums";
import type { EmailDatabase } from "../data/tables";
import { EmailInvalidPayloadError } from "../error/errors";
import { getTemplate, renderSubject } from "../templates/engine";
import type { EmailTheme } from "../templates/theme";
import { resolveTimezoneSendAt } from "./sendAt";

/**
 * Enqueue an email. A request handler only ever does this — it never sends inline. Every email becomes
 * a `pithy_email_jobs` row; an `immediate` job also kicks the send Workflow now (lowest latency), while
 * `scheduled` and `timezone` jobs are left for the every-minute scheduler to pick up. The payload is
 * validated against the template schema here, so a bad call fails at enqueue, not mid-send.
 */

/**
 * The Workflow binding used to start a send (Cloudflare `Workflow.create`). At enqueue it sends a batch
 * of one; the scheduler's fan-out starts one instance per batch through the same binding.
 *
 * `id` names the instance being created. The scheduler passes the batch's id so the instance can be
 * looked up again by the rows that carry it (pithy-sh/pithy#342); an enqueue omits it and lets the
 * platform mint one.
 */
export interface SendWorkflowBinding {
  create(options: { id?: string; params: { jobIds: string[] } }): Promise<unknown>;
}

/** What the caller provides to enqueue an email. */
export interface EnqueueInput {
  /** The recipient address. */
  to: string;
  /** The template id (e.g. `magicLink`). */
  template: string;
  /** The template input variables; validated against the template's payload schema. */
  payload: unknown;
  /** Send mode; defaults to `immediate`. */
  mode?: SendMode;
  /** For `scheduled` mode: the absolute time to send. */
  sendAt?: Date;
  /** For `timezone` mode: the recipient-local time-of-day, `HH:MM`. */
  localTime?: string;
  /** For `timezone` mode: the recipient's IANA timezone. */
  timezone?: string;
  /** The marketing campaign id, for attribution. */
  campaignId?: string;
  /** Override click-link rewriting (defaults on for marketing, off for transactional). */
  clickTracking?: boolean;
  /** Override open-pixel injection (defaults on for marketing, off for transactional). */
  openTracking?: boolean;
  /**
   * The address a recipient's answer should go to, when it is not `fromAddress`.
   *
   * `@pithy-sh/support` is what this is for: a reply is sent as the adopter's onboarded sending
   * identity (Cloudflare validates the `From` domain against exactly what was onboarded) while the
   * conversation has to come back to the support inbox, which is usually a different subdomain.
   */
  replyTo?: string;
  /**
   * The `Message-ID` this job answers, angle brackets included — the `In-Reply-To` header.
   *
   * Set together with {@link references}. Threading on ids is what keeps a customer's client showing
   * one conversation instead of one message per answer, and only the Worker holds the chain, which
   * is why a reply is enqueued here rather than composed by whatever surface a human typed it into.
   */
  inReplyTo?: string;
  /** The `References` chain, angle-bracketed and space-separated. Built by the caller from the parent. */
  references?: string;
}

/** Dependencies enqueue needs: the database, the from identity, optional send-Workflow binding, time, ids. */
export interface EnqueueDeps {
  db: EmailDatabase;
  fromAddress: string;
  fromName: string;
  theme: EmailTheme;
  /** The send Workflow binding. When present, an immediate job is dispatched now; absent, the scheduler takes it. */
  sender?: SendWorkflowBinding;
  now: Date;
  /** Generate a job id (a UUID in production). */
  newId: () => string;
}

/** The result of enqueuing: the new job id and its initial status. */
export interface EnqueueResult {
  jobId: string;
  status: EmailJobStatus;
}

/** Resolve the absolute send time and initial status from the requested mode. */
function resolveSchedule(input: EnqueueInput, now: Date): { mode: SendMode; sendAt: Date; status: EmailJobStatus } {
  const mode = input.mode ?? "immediate";
  if (mode === "immediate") return { mode, sendAt: now, status: "pending" };
  if (mode === "scheduled") {
    if (!input.sendAt) throw new EmailInvalidPayloadError({ detail: "scheduled mode requires an absolute sendAt" });
    return { mode, sendAt: input.sendAt, status: "scheduled" };
  }
  if (!input.localTime || !input.timezone) {
    throw new EmailInvalidPayloadError({ detail: "timezone mode requires localTime and timezone" });
  }
  return { mode, sendAt: resolveTimezoneSendAt(input.localTime, input.timezone, now), status: "scheduled" };
}

/** Enqueue an email job, dispatching the send Workflow immediately when the mode is `immediate`. */
export async function enqueueEmail(deps: EnqueueDeps, input: EnqueueInput): Promise<EnqueueResult> {
  const template = getTemplate(input.template);
  // Validates the payload against the template schema and computes the stored subject.
  const subject = renderSubject(input.template, input.payload, deps.theme);
  const { mode, sendAt, status } = resolveSchedule(input, deps.now);

  const marketing = template.category === "marketing";
  const job: EmailJob = {
    id: deps.newId(),
    toAddress: input.to,
    fromAddress: deps.fromAddress,
    fromName: deps.fromName,
    subject,
    template: input.template,
    category: template.category,
    payload: input.payload as Record<string, unknown>,
    payloadRedactedAt: null,
    status,
    mode,
    attempts: 0,
    sendAt,
    timezone: input.timezone ?? null,
    localTime: input.localTime ?? null,
    campaignId: input.campaignId ?? null,
    openTracking: input.openTracking ?? marketing,
    clickTracking: input.clickTracking ?? marketing,
    messageId: null,
    error: null,
    bounceCode: null,
    bounceType: null,
    replyTo: input.replyTo ?? null,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? null,
    createdAt: deps.now,
    updatedAt: deps.now,
    sentAt: null,
  };

  await deps.db.insertInto("pithyEmailJobs").values(EmailJobSchema.encode(job)).execute();

  // Immediate sends start the Workflow now for lowest latency. If the dispatch fails, the row stays
  // `pending` and the every-minute scheduler re-drives it — so a failed dispatch never loses an email.
  if (mode === "immediate" && deps.sender) {
    try {
      await deps.sender.create({ params: { jobIds: [job.id] } });
    } catch {
      // Swallowed deliberately: the scheduler's safety net owns recovery.
    }
  }

  return { jobId: job.id, status };
}
