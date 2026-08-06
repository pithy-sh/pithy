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
      sentAt: new Date("2026-06-10T09:01:00.000Z"),
    };
    accepts(EmailJobListItem, jobListView(bare));
    accepts(EmailJobDetail, jobDetailView(bare));
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
