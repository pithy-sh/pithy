// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { applyInbound, createBounceHandler } from "./handler";

/** The shared suppression database handle for the test. */
const supDb = () => emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS);

const now = new Date("2026-06-18T12:00:00.000Z");

let seq = 0;
async function insertSentJob(messageId: string, to = "u@example.com"): Promise<string> {
  const id = `job-${++seq}`;
  await env.DB.prepare(
    "insert into pithy_email_jobs (id, to_address, from_address, from_name, subject, template, category, payload, status, mode, attempts, send_at, open_tracking, click_tracking, message_id, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      to,
      "noreply@pithy.sh",
      "Acme",
      "S",
      "welcome",
      "transactional",
      "{}",
      "sent",
      "immediate",
      1,
      1000,
      0,
      0,
      messageId,
      1000,
      1000,
    )
    .run();
  return id;
}

async function jobStatus(id: string): Promise<{ status: string; bounce_type: string | null }> {
  const row = await env.DB.prepare("select status, bounce_type from pithy_email_jobs where id = ?")
    .bind(id)
    .first<{ status: string; bounce_type: string | null }>();
  return row ?? { status: "missing", bounce_type: null };
}

async function suppressionCount(email: string): Promise<number> {
  const row = await env.EMAIL_SUPPRESSIONS.prepare("select count(*) as n from pithy_email_suppressions where email = ?")
    .bind(email)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  seq = 0;
  for (const table of ["pithy_email_jobs", "pithy_email_events"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await env.EMAIL_SUPPRESSIONS.prepare("drop table if exists pithy_email_suppressions").run();
  await email_0001_init.up(emailDatabase(env.DB));
  await email_0001_suppressions.up(emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS));
});

describe("applyInbound", () => {
  test("a hard bounce suppresses the address and marks the job bounced", async () => {
    const jobId = await insertSentJob("send-abc@pithy.sh");
    const outcome = await applyInbound(
      emailDatabase(env.DB),
      supDb(),
      { type: "hard", recipient: "u@example.com", code: "5.1.1", originalMessageId: "send-abc@pithy.sh" },
      now,
    );

    expect(outcome).toMatchObject({ acted: true, suppressed: true, jobId });
    expect(await jobStatus(jobId)).toEqual({ status: "bounced", bounce_type: "hard" });
    expect(await suppressionCount("u@example.com")).toBe(1);
  });

  test("a complaint suppresses with reason complaint", async () => {
    const jobId = await insertSentJob("send-c@pithy.sh", "angry@example.com");
    await applyInbound(
      emailDatabase(env.DB),
      supDb(),
      { type: "complaint", recipient: "angry@example.com", originalMessageId: "send-c@pithy.sh" },
      now,
    );

    const sup = await env.EMAIL_SUPPRESSIONS.prepare("select reason from pithy_email_suppressions where email = ?")
      .bind("angry@example.com")
      .first<{ reason: string }>();
    expect(sup?.reason).toBe("complaint");
    expect((await jobStatus(jobId)).status).toBe("bounced");
  });

  test("a soft bounce records the event but does not suppress", async () => {
    const jobId = await insertSentJob("send-soft@pithy.sh");
    await applyInbound(
      emailDatabase(env.DB),
      supDb(),
      { type: "soft", recipient: "u@example.com", code: "4.2.2", originalMessageId: "send-soft@pithy.sh" },
      now,
    );

    expect(await suppressionCount("u@example.com")).toBe(0);
    expect((await jobStatus(jobId)).bounce_type).toBe("soft");
    expect((await jobStatus(jobId)).status).toBe("sent"); // unchanged
  });

  test("an auto-reply is a no-op", async () => {
    const outcome = await applyInbound(emailDatabase(env.DB), supDb(), { type: "auto_reply" }, now);
    expect(outcome.acted).toBe(false);
    expect(await suppressionCount("u@example.com")).toBe(0);
  });

  test("a hard bounce with no matching job still suppresses the address", async () => {
    const outcome = await applyInbound(
      emailDatabase(env.DB),
      supDb(),
      { type: "hard", recipient: "ghost@example.com", code: "5.0.0" },
      now,
    );
    expect(outcome).toMatchObject({ suppressed: true, jobId: undefined });
    expect(await suppressionCount("ghost@example.com")).toBe(1);
  });
});

describe("createBounceHandler (parse + classify + apply)", () => {
  test("parses a DSN message and suppresses the bounced recipient", async () => {
    const jobId = await insertSentJob("send-mime@pithy.sh");
    const raw = [
      "From: mailer-daemon@pithy.sh",
      "To: bounces@pithy.sh",
      "Subject: Delivery Status Notification (Failure)",
      "Content-Type: multipart/report; report-type=delivery-status; boundary=b",
      "",
      "--b",
      "Content-Type: message/delivery-status",
      "",
      "Original-Message-ID: <send-mime@pithy.sh>",
      "Final-Recipient: rfc822;u@example.com",
      "Action: failed",
      "Status: 5.1.1",
      "--b--",
      "",
    ].join("\r\n");

    const message = {
      from: "mailer-daemon@pithy.sh",
      to: "bounces@pithy.sh",
      headers: new Headers(),
      raw: new Response(raw).body as ReadableStream<Uint8Array>,
      rawSize: raw.length,
      setReject() {},
      async forward() {},
      async reply() {},
    } as unknown as ForwardableEmailMessage;

    const handler = createBounceHandler();
    await handler(
      message,
      { DB: env.DB, EMAIL_SUPPRESSIONS: env.EMAIL_SUPPRESSIONS } as unknown as Record<string, unknown>,
      {} as ExecutionContext,
    );

    expect(await suppressionCount("u@example.com")).toBe(1);
    expect((await jobStatus(jobId)).status).toBe("bounced");
  });
});
