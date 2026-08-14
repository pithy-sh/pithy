// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { EmailJob } from "../data/emailJob";
import { EmailJob as EmailJobSchema } from "../data/emailJob";
import type { EmailJobStatus, SendMode } from "../data/enums";
import type { EmailDatabase } from "../data/tables";
import { EmailInvalidPayloadError } from "../error/errors";
import { getTemplate, renderSubject } from "../templates/engine";
import type { EmailTheme } from "../templates/theme";
import { mintBatchId } from "./batchIdentity";
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
 * `id` names the instance being created, and **every dispatcher passes one** (pithy-sh/pithy#342): the
 * scheduler passes its batch's, an enqueue passes the one it just stamped on the row, and a retry passes
 * the one it minted to replace the failed batch's. It is optional here only because the platform allows
 * omitting it, and omitting it is what made an immediate send unattributable to any instance — so the
 * row could not say a Workflow was coming and the safety net sent a second one. See
 * `send/batchIdentity.ts`.
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
  /**
   * Mint the id of the batch this enqueue dispatches — **the send Workflow instance's id**
   * (pithy-sh/pithy#342). Defaults to {@link mintBatchId}; injected only so a test can name it.
   */
  newBatchId?: () => string;
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

  // Whether this call starts a send Workflow at all: only an immediate job does, and only where a
  // binding exists to start one on. Everything else is left for the scheduler to claim.
  const sender = mode === "immediate" ? deps.sender : undefined;
  /**
   * The batch this enqueue is about to start — named here, before the row exists, because the row has to
   * carry it (pithy-sh/pithy#342).
   *
   * Without it the row is born naming nobody, and a row naming nobody is stranded by definition: the
   * scheduler's safety net claims any `pending` job older than `graceMs` and starts a *second* send
   * Workflow for it. That is not a hypothetical race with a slow enqueue — it is the ordinary shape of a
   * transient send failure. `runSend` throws on a retryable error so the Workflow step backs off, and a
   * backoff writes nothing at all, so the very first retry leaves the row looking exactly like a dispatch
   * that died. `runSend` short-circuits only a job already `sent`, so both instances would render and
   * both would call the Email Service. One person, two emails.
   *
   * Null for a `scheduled` or `timezone` job, and for an immediate one with no binding, because in those
   * cases nothing is coming for the row and saying otherwise would hold it against a batch that does not
   * exist.
   */
  const batchId = sender ? (deps.newBatchId ?? mintBatchId)() : null;

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
    batchId,
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

  // Immediate sends start the Workflow now for lowest latency, under the id the row already carries —
  // the row is written first so the instance can never be alive before the row can name it.
  //
  // If the dispatch fails, the row stays `pending` naming an instance the runtime has never heard of.
  // `batchIsAlive` turns that into "not alive", so the scheduler re-drives it on the next tick exactly
  // as it did before batch ids existed — a failed dispatch still never loses an email. And if the
  // failure was only the *answer* going missing, the instance is there and alive, the row names it, and
  // the tick holds off: the case that used to be a double-send is now the case the id was minted for.
  if (sender && batchId) {
    try {
      await sender.create({ id: batchId, params: { jobIds: [job.id] } });
    } catch {
      // Swallowed deliberately: the scheduler's safety net owns recovery.
    }
  }

  return { jobId: job.id, status };
}
