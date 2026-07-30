// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { EmailEvent } from "./emailEvent";
import { EmailJob } from "./emailJob";
import { EmailSuppression } from "./emailSuppression";

describe("EmailJob codec round-trip", () => {
  test("a SQLite row decodes to the app shape and re-encodes losslessly", () => {
    const row = {
      id: "job-1",
      toAddress: "u@example.com",
      fromAddress: "noreply@pithy.sh",
      fromName: "Pithy",
      subject: "Welcome",
      template: "welcome",
      category: "transactional",
      payload: JSON.stringify({ name: "Sam" }),
      status: "sent",
      mode: "immediate",
      attempts: 1,
      sendAt: 1_700_000_000_000,
      timezone: null,
      localTime: null,
      campaignId: null,
      openTracking: 0,
      clickTracking: 0,
      messageId: "msg-abc",
      error: null,
      bounceCode: null,
      bounceType: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_500,
      sentAt: 1_700_000_000_500,
    } as const;

    const job = EmailJob.parse(row);
    expect(job.payload).toEqual({ name: "Sam" });
    expect(job.openTracking).toBe(false);
    expect(job.sentAt).toBeInstanceOf(Date);
    expect(job.createdAt.getTime()).toBe(1_700_000_000_000);

    const encoded = EmailJob.encode(job);
    expect(encoded.openTracking).toBe(0);
    expect(encoded.sendAt).toBe(1_700_000_000_000);
    expect(JSON.parse(encoded.payload as string)).toEqual({ name: "Sam" });
  });

  test("an unknown category is rejected", () => {
    expect(() => EmailJob.parse({ category: "spammy" } as never)).toThrow();
  });
});

describe("EmailEvent codec round-trip", () => {
  test("a click event round-trips with link identity", () => {
    const event = EmailEvent.parse({
      id: 1,
      jobId: "job-1",
      recipient: "u@example.com",
      type: "click",
      linkLabel: "cta",
      linkUrl: "https://example.com/welcome",
      campaignId: "spring",
      detail: null,
      createdAt: 1_700_000_000_000,
    });
    expect(event.type).toBe("click");
    expect(EmailEvent.encode(event).createdAt).toBe(1_700_000_000_000);
  });
});

describe("EmailSuppression codec round-trip", () => {
  test("a suppression row decodes and a temporary one keeps its expiry", () => {
    const row = EmailSuppression.parse({
      id: 1,
      email: "bounced@example.com",
      reason: "hard_bounce",
      jobId: "job-1",
      detail: "550 no such user",
      createdAt: 1_700_000_000_000,
      expiresAt: null,
    });
    expect(row.reason).toBe("hard_bounce");
    expect(row.expiresAt).toBeNull();
  });
});
