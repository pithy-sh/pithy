// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import type { CapabilityEmailHandler } from "@pithy-sh/core/src/capability/capability";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import PostalMime from "postal-mime";
import {
  type EmailDatabase,
  type EmailSuppressionDatabase,
  emailDatabase,
  emailSuppressionDatabase,
} from "../data/tables";
import { recordEvent } from "../send/events";
import { suppress } from "../send/suppression";
import { classifyInbound, type InboundClassification } from "./classify";

/**
 * The inbound bounce/complaint handler — the capability's `email()` seam. The Worker entrypoint fans
 * incoming mail to it; it parses the message, classifies it, and applies the result: a hard bounce or
 * complaint suppresses the address and marks the originating job bounced; a soft bounce records the
 * event but does not suppress (Cloudflare auto-retries those); an auto-reply or anything unrecognized is
 * a no-op. The job is matched by the original `Message-ID` against the stored send `messageId`.
 */

/** What `applyInbound` did, for logging and tests. */
export interface InboundOutcome {
  /** Whether any side effect was applied (false for auto-reply / ignore). */
  acted: boolean;
  /** The classification type. */
  type: InboundClassification["type"];
  /** The job id matched by original Message-ID, if any. */
  jobId?: string;
  /** Whether the address was added to the suppression list. */
  suppressed: boolean;
}

/**
 * Apply a classification's side effects. Suppression is written to the **shared** suppression database
 * (so it applies in every environment); the job lookup and the bounce/complaint event use the app
 * database. Pure of any MIME parsing — unit-testable. Note the single inbound worker only reaches its
 * own app DB, so a job-row update is best-effort (the originating job may live in another environment),
 * whereas the suppression — the safety-critical part — is always global.
 */
export async function applyInbound(
  db: EmailDatabase,
  suppressionDb: EmailSuppressionDatabase,
  c: InboundClassification,
  now: Date,
  environment?: string,
): Promise<InboundOutcome> {
  if (c.type === "ignore" || c.type === "auto_reply") return { acted: false, type: c.type, suppressed: false };

  // Match the originating job by the original Message-ID against the stored send messageId.
  const job = c.originalMessageId
    ? await db
        .selectFrom("pithyEmailJobs")
        .select(["id", "toAddress", "status", "campaignId"])
        .where("messageId", "=", c.originalMessageId)
        .executeTakeFirst()
    : undefined;

  const recipient = c.recipient ? normalizeAddress(c.recipient) : job ? normalizeAddress(job.toAddress) : undefined;
  const isSuppressing = c.type === "hard" || c.type === "complaint";
  let suppressed = false;

  if (recipient && isSuppressing) {
    await suppress(
      suppressionDb,
      {
        email: recipient,
        reason: c.type === "complaint" ? "complaint" : "hard_bounce",
        jobId: job?.id ?? null,
        environment,
        detail: c.code ?? null,
      },
      now,
    );
    suppressed = true;
  }

  if (job) {
    await db
      .updateTable("pithyEmailJobs")
      .set({
        bounceCode: c.code ?? null,
        bounceType: c.type,
        status: isSuppressing ? "bounced" : job.status,
        updatedAt: SQLiteDate.encode(now),
      })
      .where("id", "=", job.id)
      .execute();
    // Record the event with the job's campaign so batch analytics (opens/clicks/bounces/unsubscribes
    // per campaign) see bounces alongside the rest.
    await recordEvent(
      db,
      {
        jobId: job.id,
        recipient: recipient ?? normalizeAddress(job.toAddress),
        type: c.type === "complaint" ? "complaint" : "bounce",
        campaignId: job.campaignId ?? null,
        detail: c.code ?? null,
      },
      now,
    );
  }

  return { acted: suppressed || Boolean(job), type: c.type, jobId: job?.id, suppressed };
}

/** Build the inbound-email handler for the `Capability.email` seam. Reads `DB` + `EMAIL_SUPPRESSIONS` from env. */
export function createBounceHandler(): CapabilityEmailHandler {
  return async (message, env) => {
    const raw = await new Response(message.raw).text();
    const parsed = await PostalMime.parse(raw);
    const headers: Record<string, string> = {};
    for (const header of parsed.headers) headers[header.key.toLowerCase()] = header.value;

    const classification = classifyInbound({
      contentType: headers["content-type"],
      autoSubmitted: headers["auto-submitted"],
      autoReplyHeader: "x-autoreply" in headers || "x-autorespond" in headers,
      raw,
    });

    const bindings = env as unknown as { DB: D1Database; EMAIL_SUPPRESSIONS: D1Database; ENVIRONMENT?: string };
    await applyInbound(
      emailDatabase(bindings.DB),
      emailSuppressionDatabase(bindings.EMAIL_SUPPRESSIONS),
      classification,
      new Date(),
      bindings.ENVIRONMENT,
    );
  };
}
