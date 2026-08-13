// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import type { DatabaseSchema } from "@pithy-sh/core/src/data/db";
import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import type { Updateable } from "kysely";
import { EmailJob, SPENT_PAYLOAD } from "../data/emailJob";
import type { EmailJobStatus, SuppressionReason } from "../data/enums";
import type { EmailDatabase, EmailSuppressionDatabase, EmailTables } from "../data/tables";
import { type RenderTracking, redactsPayloadOnDelivery, renderEmail, templateKind } from "../templates/engine";
import type { EmailTheme } from "../templates/theme";
import { classifySendError } from "./errorMapping";
import { recordEvent } from "./events";
import type { EmailSender } from "./sender";
import { blockingSuppression, suppress } from "./suppression";

/**
 * Send one job — the body the send Workflow runs inside a durable step. Never called from a request
 * handler. It loads the job, skips a suppressed recipient, renders (with tracking per the job's flags),
 * sends through the binding, and records the outcome on the row plus an event. On a retryable failure
 * it throws (the Workflow step retries with backoff) until `maxAttempts`, then marks the job failed.
 *
 * **Whether a suppression applies depends on the message.** The kind comes from the template, not from
 * the job row and not from a caller, so a magic link is transactional by declaration and an unrelated
 * unsubscribe cannot swallow it.
 *
 * **A delivered job's inputs are dropped here, and "delivered" is the only place they can be.** The
 * payload of a magic link *is* the sign-in link, so a row that keeps it after the message is out is a
 * second, permanent copy of a live credential in a table nobody thinks of as holding secrets — which is
 * what made an adopter's digested invitation token worth nothing the moment it was mailed. The line is
 * `sent`, and every other outcome keeps its payload on purpose: `failed` can be retried, `suppressed`
 * can be unblocked, and a payload dropped before the last attempt is a message that cannot be resent —
 * a worse failure than the one being fixed. `sent` is the one status a retry is *already* refused for,
 * because the mail has gone to a real person, so nothing here can ever need those inputs again.
 */

/** The current signing key plus the valid version set, for minting tracking/unsubscribe links. */
export interface SendSigning {
  /** The current signing key value. */
  key: string;
  /** The current signing key version, recorded as the token `kid`. */
  kid: string;
}

/** Everything a send needs that isn't on the job row. */
export interface SendDeps {
  /** The per-environment jobs/events database. */
  db: EmailDatabase;
  /** The global, shared suppression database — checked before every send, fed by bounces/complaints. */
  suppressionDb: EmailSuppressionDatabase;
  sender: EmailSender;
  theme: EmailTheme;
  /** The public base URL for callback links. */
  baseUrl: string;
  /** The signing key for tracking/unsubscribe links. Absent disables tracking (and blocks marketing sends). */
  signing?: SendSigning;
  /** How long a tracked link stays valid. */
  linkTtlDays: number;
  /** The most attempts before a retryable failure becomes terminal. */
  maxAttempts: number;
  /** This worker's environment name, stamped on each send (X-Pithy-Env) so the single inbound worker can route. */
  environment?: string;
  /**
   * When this pass began — **stable across a Workflow resume** (pithy-sh/pithy#327).
   *
   * Everything that dates the work reads this: `sentAt`, the redaction stamp, the events, and how long a
   * tracked link stays valid. A driver body re-executes from the top on a resume, so a clock read there
   * answers with the resume — and a batch that backed off overnight dated its remaining jobs, and the
   * expiry of every link in them, a day late. `runSendBatch` journals this in a step so a resume reads
   * back the instant the batch began.
   *
   * A link minted on the resumed half expires from the pass, not from the mint. Two people in one batch
   * are promised the same window; which attempt happened to render their message is not something they
   * can see and not something their link should depend on.
   */
  passStartedAt: Date;
  /**
   * "This job is being worked on, now" — **read fresh on every call**, and never journalled.
   *
   * This is not a stamp with a tidier name. `updatedAt` is the scheduler's only evidence that a `sending`
   * job is alive: `runScheduler` claims and re-drives anything in `sending` older than `stuckMs`, on the
   * assumption its dispatch died. Freeze it and a batch that resumes past that window reports the job it
   * is actively retrying as stranded, so the next tick starts a second send Workflow against it — and
   * `runSend` short-circuits only a job already `sent`, so both attempts render and both call `send`. One
   * person, two emails. A sweep journalled the single `now` this replaced and was reverted for exactly
   * that.
   *
   * The suppression liveness read takes it too, because "is this address blocked *right now*" is a
   * present-tense question and an hour-old answer to it is simply wrong.
   */
  heartbeatAt: () => Date;
}

/** The outcome of a send attempt. */
export interface SendOutcome {
  jobId: string;
  status: EmailJobStatus;
  messageId?: string;
  skipped?: boolean;
  /**
   * Why nothing was sent, when the recipient was on the suppression list.
   *
   * A skipped send has to be reported, not swallowed. Without this the caller sees an outcome that is
   * not `failed` and the person sees an empty inbox, which is what made the whole class of bug invisible
   * from both ends. "Suppressed" alone is not enough either — an operator deciding what to do next needs
   * to know whether the address bounced, complained, or opted out.
   */
  suppressionReason?: SuppressionReason;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A partial update to the jobs table, in its SQLite row shape. */
type JobUpdate = Updateable<DatabaseSchema<EmailTables>["pithyEmailJobs"]>;

/**
 * Patch a job row by id, always bumping `updatedAt` — **on the heartbeat clock, not the pass instant.**
 *
 * Every write this function makes is also a statement that the job is still being worked on, because
 * `updatedAt` is what the scheduler's `sending` re-drive reads. That is why the bump is here rather than
 * at each call site: a patch that did not say "still alive" would be a patch that invited a second send
 * Workflow. See {@link SendDeps.heartbeatAt}.
 */
async function patchJob(deps: SendDeps, jobId: string, patch: JobUpdate): Promise<void> {
  await deps.db
    .updateTable("pithyEmailJobs")
    .set({ ...patch, updatedAt: SQLiteDate.encode(deps.heartbeatAt()) })
    .where("id", "=", jobId)
    .execute();
}

export async function runSend(deps: SendDeps, jobId: string): Promise<SendOutcome> {
  const row = await deps.db.selectFrom("pithyEmailJobs").selectAll().where("id", "=", jobId).executeTakeFirst();
  if (!row) throw new NotFoundError({ detail: `email job '${jobId}' not found` });
  const job = EmailJob.parse(row);

  // Idempotent: a job already sent or cancelled is a no-op (a Workflow can re-run a step).
  if (job.status === "sent") return { jobId, status: "sent", messageId: job.messageId ?? undefined };
  if (job.status === "cancelled") return { jobId, status: "cancelled", skipped: true };

  const recipient = normalizeAddress(job.toAddress);

  // A job whose inputs were dropped cannot be re-rendered. Unreachable today — only a `sent` job is
  // redacted and `sent` short-circuits two lines up — and it is here because the invariant is worth
  // more executable than commented. It fails terminally rather than throwing: a throw would retry, and
  // every attempt would render the same empty payload. What it prevents is the worse outcome, which is
  // a real person receiving a magic-link email with no link in it.
  if (job.payloadRedactedAt) {
    await patchJob(deps, jobId, { status: "failed", error: "payload dropped after delivery" });
    await recordEvent(
      deps.db,
      { jobId, recipient, type: "failed", detail: "payload already redacted" },
      deps.passStartedAt,
    );
    return { jobId, status: "failed" };
  }

  // The template's own declaration, not `job.category` and not anything the enqueuing call site chose.
  // Deriving it here means a template whose kind is corrected in a later release corrects the jobs
  // already queued against it, and that a stored value can never drift from the template it names.
  const kind = templateKind(job.template);
  // The heartbeat clock: whether an address is blocked is a question about now, and a suppression that
  // expired while this batch was backed off must not still be blocking.
  const blocked = await blockingSuppression(deps.suppressionDb, recipient, deps.heartbeatAt(), kind);
  if (blocked) {
    await patchJob(deps, jobId, { status: "suppressed", error: `recipient suppressed: ${blocked}` });
    await recordEvent(deps.db, { jobId, recipient, type: "suppressed", detail: blocked }, deps.passStartedAt);
    return { jobId, status: "suppressed", skipped: true, suppressionReason: blocked };
  }

  // A marketing send needs a signing key for its unsubscribe link; without one it cannot render. This
  // is a configuration fault, not a transient one, so fail **terminally** — return, don't throw. A
  // throw would make the Workflow step retry, and since a `failed` row isn't short-circuited above it
  // would re-enter and re-throw, burning the whole retry budget re-failing.
  if (job.category === "marketing" && !deps.signing) {
    await patchJob(deps, jobId, { status: "failed", error: "no signing key for marketing unsubscribe link" });
    await recordEvent(deps.db, { jobId, recipient, type: "failed", detail: "no signing key" }, deps.passStartedAt);
    return { jobId, status: "failed" };
  }

  const tracking: RenderTracking | undefined = deps.signing
    ? {
        baseUrl: deps.baseUrl,
        jobId,
        recipient,
        campaignId: job.campaignId ?? undefined,
        key: deps.signing.key,
        kid: deps.signing.kid,
        expiresAt: new Date(deps.passStartedAt.getTime() + deps.linkTtlDays * DAY_MS),
        openTracking: job.openTracking,
        clickTracking: job.clickTracking,
      }
    : undefined;

  const attempts = job.attempts + 1;
  await patchJob(deps, jobId, { status: "sending", attempts });

  const rendered = await renderEmail(job.template, job.payload, deps.theme, tracking);
  // Stamp the origin job and environment so the single (production) inbound worker can attribute an
  // async bounce/complaint back to where it came from. Suppression itself is global, so it applies
  // regardless; these headers carry the per-job/per-env context the platform send response cannot.
  const headers: Record<string, string> = { "X-Pithy-Job": jobId };
  if (deps.environment) headers["X-Pithy-Env"] = deps.environment;
  // Threading, when the job carries it. Both headers or neither: a client threads on `In-Reply-To`
  // and falls back to `References`, so sending one without the other is how a conversation stays
  // together in some mail clients and splits in others.
  if (job.inReplyTo) headers["In-Reply-To"] = job.inReplyTo;
  if (job.references) headers.References = job.references;
  // One-click opt-out, and **only** where the body already offers one — `rendered.unsubscribeUrl` is
  // present exactly for an elective template, so this cannot appear on a sign-in link. That restraint is
  // the point: Gmail's and Yahoo's bulk-sender rules require one-click unsubscribe for *promotional*
  // mail, and some clients surface the header as prominently as the message body. On a magic link it
  // would publish a mechanism for disabling authentication, one tap from the mail the account depends on.
  //
  // Both headers together, per RFC 8058: `List-Unsubscribe-Post` is what tells a client the URL will
  // honour a POST, and the callback accepts one for that reason. Sending it without a POST route would
  // advertise an opt-out that silently does nothing.
  if (rendered.unsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${rendered.unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  const message = {
    to: recipient,
    from: { email: job.fromAddress, name: job.fromName },
    ...(job.replyTo ? { replyTo: job.replyTo } : {}),
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers,
  };

  try {
    const result = await deps.sender.send(message);
    // The status and the redaction are one write. Two statements would leave a window in which the row
    // says `sent` and still holds the link, and the window would be exactly as long as whatever went
    // wrong between them.
    const spent = redactsPayloadOnDelivery(job.template);
    await patchJob(deps, jobId, {
      status: "sent",
      sentAt: SQLiteDate.encode(deps.passStartedAt),
      messageId: result.messageId ?? null,
      error: null,
      ...(spent ? { payload: SPENT_PAYLOAD, payloadRedactedAt: SQLiteDate.encode(deps.passStartedAt) } : {}),
    });
    await recordEvent(deps.db, { jobId, recipient, type: "sent", campaignId: job.campaignId }, deps.passStartedAt);

    // Synchronous permanent bounces (batch/REST shape) feed suppression immediately.
    for (const bounced of result.permanentBounces ?? []) {
      await suppress(
        deps.suppressionDb,
        {
          email: bounced,
          reason: "hard_bounce",
          jobId,
          environment: deps.environment,
          detail: "permanent bounce on send",
        },
        deps.passStartedAt,
      );
      await recordEvent(
        deps.db,
        { jobId, recipient: normalizeAddress(bounced), type: "bounce", detail: "permanent bounce on send" },
        deps.passStartedAt,
      );
    }

    return { jobId, status: "sent", messageId: result.messageId };
  } catch (err) {
    const classified = classifySendError(err);

    if (classified.suppressed) {
      await patchJob(deps, jobId, { status: "suppressed", error: classified.code, bounceCode: classified.code });
      await suppress(
        deps.suppressionDb,
        { email: recipient, reason: "hard_bounce", jobId, environment: deps.environment, detail: classified.code },
        deps.passStartedAt,
      );
      await recordEvent(deps.db, { jobId, recipient, type: "suppressed", detail: classified.code }, deps.passStartedAt);
      return { jobId, status: "suppressed", skipped: true };
    }

    if (classified.retryable && attempts < deps.maxAttempts) {
      // Persist the last error, then throw so the Workflow step retries with backoff (row stays `sending`).
      await patchJob(deps, jobId, { error: classified.code });
      throw classified.error;
    }

    await patchJob(deps, jobId, { status: "failed", error: classified.code });
    await recordEvent(deps.db, { jobId, recipient, type: "failed", detail: classified.code }, deps.passStartedAt);
    return { jobId, status: "failed" };
  }
}
