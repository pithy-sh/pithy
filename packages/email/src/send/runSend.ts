// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import type { DatabaseSchema } from "@pithy-sh/core/src/data/db";
import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import type { Updateable } from "kysely";
import { EmailJob } from "../data/emailJob";
import type { EmailJobStatus } from "../data/enums";
import type { EmailDatabase, EmailSuppressionDatabase, EmailTables } from "../data/tables";
import { type RenderTracking, renderEmail } from "../templates/engine";
import type { EmailTheme } from "../templates/theme";
import { classifySendError } from "./errorMapping";
import { recordEvent } from "./events";
import type { EmailSender } from "./sender";
import { isSuppressed, normalizeEmail, suppress } from "./suppression";

/**
 * Send one job — the body the send Workflow runs inside a durable step. Never called from a request
 * handler. It loads the job, skips a suppressed recipient, renders (with tracking per the job's flags),
 * sends through the binding, and records the outcome on the row plus an event. On a retryable failure
 * it throws (the Workflow step retries with backoff) until `maxAttempts`, then marks the job failed.
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
  now: Date;
}

/** The outcome of a send attempt. */
export interface SendOutcome {
  jobId: string;
  status: EmailJobStatus;
  messageId?: string;
  skipped?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A partial update to the jobs table, in its SQLite row shape. */
type JobUpdate = Updateable<DatabaseSchema<EmailTables>["pithyEmailJobs"]>;

/** Patch a job row by id, always bumping `updatedAt`. */
async function patchJob(deps: SendDeps, jobId: string, patch: JobUpdate): Promise<void> {
  await deps.db
    .updateTable("pithyEmailJobs")
    .set({ ...patch, updatedAt: SQLiteDate.encode(deps.now) })
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

  const recipient = normalizeEmail(job.toAddress);

  if (await isSuppressed(deps.suppressionDb, recipient, deps.now)) {
    await patchJob(deps, jobId, { status: "suppressed", error: "recipient on suppression list" });
    await recordEvent(deps.db, { jobId, recipient, type: "suppressed", detail: "on suppression list" }, deps.now);
    return { jobId, status: "suppressed", skipped: true };
  }

  // A marketing send needs a signing key for its unsubscribe link; without one it cannot render. This
  // is a configuration fault, not a transient one, so fail **terminally** — return, don't throw. A
  // throw would make the Workflow step retry, and since a `failed` row isn't short-circuited above it
  // would re-enter and re-throw, burning the whole retry budget re-failing.
  if (job.category === "marketing" && !deps.signing) {
    await patchJob(deps, jobId, { status: "failed", error: "no signing key for marketing unsubscribe link" });
    await recordEvent(deps.db, { jobId, recipient, type: "failed", detail: "no signing key" }, deps.now);
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
        expiresAt: new Date(deps.now.getTime() + deps.linkTtlDays * DAY_MS),
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
    await patchJob(deps, jobId, {
      status: "sent",
      sentAt: SQLiteDate.encode(deps.now),
      messageId: result.messageId ?? null,
      error: null,
    });
    await recordEvent(deps.db, { jobId, recipient, type: "sent", campaignId: job.campaignId }, deps.now);

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
        deps.now,
      );
      await recordEvent(
        deps.db,
        { jobId, recipient: normalizeEmail(bounced), type: "bounce", detail: "permanent bounce on send" },
        deps.now,
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
        deps.now,
      );
      await recordEvent(deps.db, { jobId, recipient, type: "suppressed", detail: classified.code }, deps.now);
      return { jobId, status: "suppressed", skipped: true };
    }

    if (classified.retryable && attempts < deps.maxAttempts) {
      // Persist the last error, then throw so the Workflow step retries with backoff (row stays `sending`).
      await patchJob(deps, jobId, { error: classified.code });
      throw classified.error;
    }

    await patchJob(deps, jobId, { status: "failed", error: classified.code });
    await recordEvent(deps.db, { jobId, recipient, type: "failed", detail: classified.code }, deps.now);
    return { jobId, status: "failed" };
  }
}
