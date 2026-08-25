// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { z } from "zod";
import type { EmailJob } from "../data/emailJob";
import type { EmailSuppression } from "../data/emailSuppression";
import {
  EmailJobDetail,
  EmailJobListItem,
  EmailJobResponse,
  EmailJobRetryResponse,
  EmailJobsResponse,
  EmailSuppressionsResponse,
  EmailSuppressionView,
  EmailSuppressResponse,
  EmailUnsuppressResponse,
} from "./responses";
import { jobDetailView, jobListView, suppressionView } from "./view";

/**
 * The response schemas against what the projections actually produce.
 *
 * **Equality, not `.parse()` alone.** A Zod object strips unknown keys, so a bare parse passes a
 * projection that has grown a field the schema never heard of. Comparing the parsed value with the
 * input fails in both directions, which is what makes the two unable to drift silently.
 */
function accepts<T>(schema: z.ZodType<T>, value: unknown): void {
  expect(schema.parse(value)).toEqual(value);
}

const NOW = new Date("2026-06-10T12:00:00.000Z");

const JOB: EmailJob = {
  id: "job-1",
  toAddress: "ada@example.test",
  recipientKey: "ada@example.test",
  fromAddress: "hello@acme.test",
  fromName: "Acme",
  subject: "Your receipt for order 4471",
  template: "receipt",
  category: "transactional",
  payload: { orderId: "4471" },
  status: "failed",
  mode: "timezone",
  attempts: 2,
  sendAt: new Date("2026-06-10T09:00:00.000Z"),
  timezone: "Europe/London",
  localTime: "09:00",
  campaignId: "camp-1",
  openTracking: true,
  clickTracking: false,
  messageId: "msg-1",
  error: "550 5.1.1 <ada@example.test> user unknown",
  bounceCode: "5.1.1",
  bounceType: "hard",
  locale: "es-AR",
  replyTo: "support@acme.test",
  inReplyTo: "<a@b>",
  references: "<a@b>",
  createdAt: new Date("2026-06-10T08:00:00.000Z"),
  updatedAt: NOW,
  sentAt: null,
};

const SUPPRESSION: EmailSuppression = {
  id: 7,
  email: "ada@example.test",
  reason: "hard_bounce",
  jobId: "job-1",
  environment: "prod",
  detail: "5.1.1",
  createdAt: new Date("2026-06-09T00:00:00.000Z"),
  expiresAt: new Date("2026-06-11T00:00:00.000Z"),
};

describe("email response schemas", () => {
  test("each projection is exactly what its schema declares", () => {
    accepts(EmailJobListItem, jobListView(JOB));
    accepts(EmailJobDetail, jobDetailView(JOB));
    accepts(EmailSuppressionView, suppressionView(SUPPRESSION, NOW));
    accepts(EmailSuppressionView, suppressionView({ ...SUPPRESSION, expiresAt: null }, NOW));
  });

  test("a job with every optional column empty still matches", () => {
    const bare: EmailJob = {
      ...JOB,
      campaignId: null,
      bounceType: null,
      messageId: null,
      error: null,
      bounceCode: null,
      timezone: null,
      localTime: null,
      locale: null,
      sentAt: new Date("2026-06-10T09:01:00.000Z"),
    };
    accepts(EmailJobListItem, jobListView(bare));
    accepts(EmailJobDetail, jobDetailView(bare));
  });

  test("the list carries the locale a message went out in, and its absence", () => {
    // The column a pane scans to answer "why is half this account getting English". A BCP-47 tag is
    // structural exactly as `template` and `category` are — it names the kind of mail, not a character
    // of its content and not a character of the recipient — so it belongs on the surface built for
    // scanning rather than behind the one audited disclosure the detail route makes.
    expect(jobListView(JOB).locale).toBe("es-AR");
    // Null is the fact somebody diagnosing that account is looking for: nobody chose, so it went out
    // in the kit's English. The `undefined` asserted below is a type-level state, not a stored
    // one. `EmailJob.locale` is `Locale.nullish()`, so the key is optional on the in-memory job and a
    // caller can build one without ever naming it. Nothing D1 hands back is ever `undefined`: `locale`
    // was folded into `0001_init`, so no persisted row predates the column, and `selectAll()` reads an
    // unset one as SQL null. The projection has to settle both or a client sees a third state the
    // schema never declared.
    expect(jobListView({ ...JOB, locale: null }).locale).toBeNull();
    expect(jobListView({ ...JOB, locale: undefined }).locale).toBeNull();
    // One declaration, so the detail cannot describe the same tag differently: it inherits this one.
    // Which is also why that sentence says only what the tag means — a description is generated
    // documentation on both routes, so one that placed the field would be false on the second.
    expect(EmailJobListItem.shape.locale.description).toBe(EmailJobDetail.shape.locale.description);
  });

  test("the template payload is declared on neither view", () => {
    // A `magicLink` payload is a sign-in URL and an `otp` payload is the code. Projecting either would
    // turn the least privileged scope this capability defines into account takeover, so the schema must
    // not tell a client it is part of the contract any more than the projection may emit it.
    expect(Object.keys(EmailJobListItem.shape)).not.toContain("payload");
    expect(Object.keys(EmailJobDetail.shape)).not.toContain("payload");
    // The list is the bulk surface, so the whole address is the detail route's alone.
    expect(Object.keys(EmailJobListItem.shape)).not.toContain("toAddress");
    expect(Object.keys(EmailJobDetail.shape)).toContain("toAddress");
    // And the subject with it. It is rendered content, it routinely names the recipient's own things,
    // and it belongs where the address is — a structural tag that scans across a page is not a reason
    // to bring the words along.
    expect(Object.keys(EmailJobListItem.shape)).not.toContain("subject");
    expect(Object.keys(EmailJobDetail.shape)).toContain("subject");
  });

  test("the envelopes accept what the routes return", () => {
    accepts(EmailJobsResponse, { jobs: [jobListView(JOB)], nextCursor: null });
    accepts(EmailJobsResponse, { jobs: [], nextCursor: "eyJpZCI6MX0" });
    accepts(EmailJobResponse, { job: jobDetailView(JOB) });
    accepts(EmailJobRetryResponse, { job: jobDetailView(JOB), dispatched: true });
    accepts(EmailSuppressionsResponse, { suppressions: [suppressionView(SUPPRESSION, NOW)], nextCursor: null });
    accepts(EmailSuppressResponse, { suppression: suppressionView(SUPPRESSION, NOW) });
    accepts(EmailSuppressResponse, { suppression: null });
    accepts(EmailUnsuppressResponse, { email: "ada@example.test", removed: true });
  });
});
