// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { normalizeAddress } from "@pithy-sh/core/src/address/address";
import type { CapabilityEmailHandler } from "@pithy-sh/core/src/capability/capability";
import { SQLiteDate } from "@pithy-sh/core/src/data/codecs";
import { createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
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
  /** Each part left undone because the database it writes to was not given, in the order they were reached. */
  skipped: InboundSkip[];
}

/** One part of applying a classification that did not run, and the binding it needed. */
export interface InboundSkip {
  /** `job` is the job lookup, its bounce marking and its event; `suppression` is the suppression-list write. */
  part: "job" | "suppression";
  /** The Worker binding that part writes through. */
  binding: "DB" | "EMAIL_SUPPRESSIONS";
}

/**
 * Apply a classification's side effects. Suppression is written to the **shared** suppression database
 * (so it applies in every environment); the job lookup and the bounce/complaint event use the app
 * database. Pure of any MIME parsing — unit-testable. Note the single inbound worker only reaches its
 * own app DB, so a job-row update is best-effort (the originating job may live in another environment),
 * whereas the suppression — the safety-critical part — is always global.
 *
 * Each part runs on the database it needs and no other: a missing app database skips the job, a missing
 * suppression database skips the suppression, and each skip is reported in `skipped` rather than thrown.
 */
export async function applyInbound(
  db: EmailDatabase | undefined,
  suppressionDb: EmailSuppressionDatabase | undefined,
  c: InboundClassification,
  now: Date,
  environment?: string,
): Promise<InboundOutcome> {
  if (c.type === "ignore" || c.type === "auto_reply") {
    return { acted: false, type: c.type, suppressed: false, skipped: [] };
  }
  const skipped: InboundSkip[] = [];
  if (db === undefined) skipped.push({ part: "job", binding: "DB" });

  // Match the originating job by the original Message-ID against the stored send messageId.
  const job =
    c.originalMessageId && db
      ? await db
          .selectFrom("pithyEmailJobs")
          .select(["id", "toAddress", "status", "campaignId"])
          .where("messageId", "=", c.originalMessageId)
          .executeTakeFirst()
      : undefined;

  const recipient = c.recipient ? normalizeAddress(c.recipient) : job ? normalizeAddress(job.toAddress) : undefined;
  const isSuppressing = c.type === "hard" || c.type === "complaint";
  let suppressed = false;

  if (recipient && isSuppressing && suppressionDb === undefined) {
    skipped.push({ part: "suppression", binding: "EMAIL_SUPPRESSIONS" });
  } else if (recipient && isSuppressing && suppressionDb) {
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

  if (job && db) {
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

  return { acted: suppressed || Boolean(job), type: c.type, jobId: job?.id, suppressed, skipped };
}

/**
 * Build the inbound-email handler for the `Capability.email` seam. Reads `DB` + `EMAIL_SUPPRESSIONS` from env.
 *
 * It never throws. `createEntrypoint` runs every capability's handler in turn, so a throw here would stop the ones
 * after it, and a throw out of `email()` is a delivery failure the sender sees. A failure is logged with its error
 * and the handler returns. It classifies before it touches a binding: a message it will not act on needs neither
 * database, and each part of a bounce runs on the binding it needs, with a part whose binding is missing logged at
 * warn rather than thrown.
 */
export function createBounceHandler(): CapabilityEmailHandler {
  return async (message, env) => {
    const environment = typeof env.ENVIRONMENT === "string" ? env.ENVIRONMENT : undefined;
    const log = createWorkerLogger({ name: "email", fields: { env: environment ?? "unknown" } });
    try {
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
      if (classification.type === "ignore" || classification.type === "auto_reply") return;

      const { DB: db, EMAIL_SUPPRESSIONS: suppressions } = env;
      const outcome = await applyInbound(
        isD1(db) ? emailDatabase(db) : undefined,
        isD1(suppressions) ? emailSuppressionDatabase(suppressions) : undefined,
        classification,
        new Date(),
        environment,
      );
      for (const { part, binding } of outcome.skipped) {
        log.warn(
          `email ${part === "job" ? "bounce not recorded on its job" : "address not suppressed"} — no ${binding} binding`,
          {
            binding,
            skipped: part,
            type: classification.type,
            action: `Bind \`${binding}\` in this Worker's wrangler.jsonc.`,
          },
        );
      }
    } catch (error) {
      log.error("email inbound handling failed", { error });
    }
  };
}

/** Whether a binding is there to open: a D1 binding is an object, and an absent one is `undefined`. */
function isD1(binding: unknown): binding is D1Database {
  return typeof binding === "object" && binding !== null;
}
