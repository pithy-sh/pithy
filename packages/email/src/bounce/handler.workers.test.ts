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

/**
 * The trust boundary (#47).
 *
 * An inbound message is untrusted input from the open internet. Cloudflare's Email Routing accepts mail
 * for the routed address from anyone who can find the MX, and hands it to `email()` unfiltered — the
 * live suite (`inboundRouting.integration.test.ts`) proves that a sender's own headers arrive intact.
 * So every one of these is a message an attacker can actually send, not a hypothetical.
 *
 * **The invariant is that the handler never throws.** A throw out of `email()` is a delivery failure
 * Cloudflare retries, which turns one hostile message into several — and the same message will fail
 * again, so the retry is a free amplifier. Refusing to act is the correct answer to garbage; crashing
 * is not.
 */
describe("createBounceHandler — untrusted input", () => {
  /** A `ForwardableEmailMessage` carrying exactly these bytes. */
  function inbound(raw: string | Uint8Array): ForwardableEmailMessage {
    const body = new Response(raw).body;
    return {
      from: "stranger@example.net",
      to: "bounces@pithy.sh",
      headers: new Headers(),
      raw: body as ReadableStream<Uint8Array>,
      rawSize: typeof raw === "string" ? raw.length : raw.byteLength,
      setReject() {},
      async forward() {},
      async reply() {},
    } as unknown as ForwardableEmailMessage;
  }

  /** Run the real handler over these bytes, against the real databases. */
  async function handle(raw: string | Uint8Array): Promise<void> {
    await createBounceHandler()(
      inbound(raw),
      { DB: env.DB, EMAIL_SUPPRESSIONS: env.EMAIL_SUPPRESSIONS } as unknown as Record<string, unknown>,
      {} as ExecutionContext,
    );
  }

  /** How many rows the suppression table holds — the blast radius of anything that gets through. */
  async function suppressionTotal(): Promise<number> {
    const row = await env.EMAIL_SUPPRESSIONS.prepare("select count(*) as n from pithy_email_suppressions").first<{
      n: number;
    }>();
    return row?.n ?? 0;
  }

  test("an empty message is a no-op, not a crash", async () => {
    await expect(handle("")).resolves.toBeUndefined();
    expect(await suppressionTotal()).toBe(0);
  });

  test("bytes that are not a message at all are a no-op", async () => {
    // Invalid UTF-8 on purpose: a lone continuation byte and a truncated sequence. `Response.text()`
    // replaces rather than throws, and the classifier must survive what it gets.
    await expect(handle(new Uint8Array([0x80, 0xff, 0xc3, 0x28, 0x00, 0x01, 0x02]))).resolves.toBeUndefined();
    expect(await suppressionTotal()).toBe(0);
  });

  test("a message that stops mid-header is a no-op", async () => {
    await expect(handle("From: a@b.c\r\nContent-Type: multipart/report; report-ty")).resolves.toBeUndefined();
    expect(await suppressionTotal()).toBe(0);
  });

  test("a header block with no body and no terminator is a no-op", async () => {
    await expect(handle("Subject: nothing\r\nTo: bounces@pithy.sh")).resolves.toBeUndefined();
    expect(await suppressionTotal()).toBe(0);
  });

  test("a forged Authentication-Results does not make an ordinary message act", async () => {
    // The live suite proves a sender's headers survive delivery, so this header is attacker-supplied
    // whenever Cloudflare did not write it. Nothing in the classifier may read it — and nothing does,
    // which is the property worth pinning before somebody adds a shortcut that does.
    const raw = [
      "From: stranger@example.net",
      "To: bounces@pithy.sh",
      "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=pithy.sh",
      "Subject: hello",
      "",
      "not a bounce",
      "",
    ].join("\r\n");

    await expect(handle(raw)).resolves.toBeUndefined();
    expect(await suppressionTotal()).toBe(0);
  });

  test("a hostile recipient cannot smuggle SQL into the suppression write", async () => {
    const hostile = `x'; drop table pithy_email_suppressions; --@example.net`;
    const raw = [
      "Content-Type: multipart/report; report-type=delivery-status; boundary=b",
      "",
      "--b",
      "Content-Type: message/delivery-status",
      "",
      `Final-Recipient: rfc822;${hostile}`,
      "Action: failed",
      "Status: 5.1.1",
      "--b--",
      "",
    ].join("\r\n");

    await expect(handle(raw)).resolves.toBeUndefined();
    // The table is still there, and the address was stored as the literal text it is. Kysely
    // parameterizes, so this is a regression pin rather than a discovery.
    const row = await env.EMAIL_SUPPRESSIONS.prepare("select email from pithy_email_suppressions where email = ?")
      .bind(hostile.toLowerCase())
      .first<{ email: string }>();
    expect(row?.email).toBe(hostile.toLowerCase());
  });

  test("a recipient broken across two lines yields no address, not half of one", async () => {
    // The DSN fields are line-structured and read with an `^…$` multiline match, so a CRLF inside an
    // address ends the field early. What must not happen is a half-address reaching the suppression
    // table, where it would be a permanent block on a string nobody can explain.
    const raw = [
      "Content-Type: multipart/report; report-type=delivery-status; boundary=b",
      "",
      "--b",
      "Content-Type: message/delivery-status",
      "",
      "Final-Recipient: rfc822;vic",
      "tim@example.com",
      "Action: failed",
      "Status: 5.1.1",
      "--b--",
      "",
    ].join("\r\n");

    await handle(raw);
    expect(await suppressionTotal()).toBe(0);
  });

  test("an appended Final-Recipient cannot override the one already read", async () => {
    // The classifier takes the first match. A second line naming somebody else is the cheapest way to
    // aim a forged bounce at a third party, and it does not work.
    const raw = [
      "Content-Type: multipart/report; report-type=delivery-status; boundary=b",
      "",
      "--b",
      "Content-Type: message/delivery-status",
      "",
      "Final-Recipient: rfc822;named-first@example.com",
      "Final-Recipient: rfc822;appended-second@example.com",
      "Action: failed",
      "Status: 5.1.1",
      "--b--",
      "",
    ].join("\r\n");

    await handle(raw);
    expect(await suppressionCount("named-first@example.com")).toBe(1);
    expect(await suppressionCount("appended-second@example.com")).toBe(0);
  });

  test("an oversized message is parsed or refused, never left to run away", async () => {
    // Cloudflare caps an inbound message well below this. The point is the shape of the failure: a
    // megabyte of body must not turn a linear scan into a quadratic one, and must not throw.
    const raw = [
      "From: stranger@example.net",
      "To: bounces@pithy.sh",
      "Subject: large",
      "",
      "A".repeat(1_000_000),
      "",
    ].join("\r\n");

    const started = Date.now();
    await expect(handle(raw)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await suppressionTotal()).toBe(0);
  });

  test("thousands of Message-ID headers do not stall the handler", async () => {
    // `originalMessageId` scans every `Message-ID` in the message and keeps the last. A message can
    // carry as many as the sender likes, so the scan's cost is attacker-chosen.
    const ids = Array.from({ length: 5000 }, (_, index) => `Message-ID: <flood-${index}@example.net>`);
    const raw = ["Content-Type: text/plain", "", ...ids, ""].join("\r\n");

    const started = Date.now();
    await expect(handle(raw)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await suppressionTotal()).toBe(0);
  });

  test("an unauthenticated stranger can suppress any address they name (#93)", async () => {
    // Recorded, not endorsed. Nothing authenticates the sender of an inbound message today: the live
    // suite shows Cloudflare stamps a verdict but the handler reads none, so a DSN invented by anyone
    // who can reach the routed address suppresses whatever `Final-Recipient` it claims. The ceiling is
    // a denial of delivery, never a disclosure — the row carries no data back to the sender.
    //
    // This is the whole case for #93 (verify DKIM inside the Worker), and the live suite settles its
    // precondition: `DKIM-Signature` survives delivery, so verification is possible. If #93 lands, this
    // test is the one that must change.
    const raw = [
      "Content-Type: multipart/report; report-type=delivery-status; boundary=b",
      "",
      "--b",
      "Content-Type: message/delivery-status",
      "",
      "Final-Recipient: rfc822;someone-elses-customer@example.com",
      "Action: failed",
      "Status: 5.1.1",
      "--b--",
      "",
    ].join("\r\n");

    await handle(raw);
    expect(await suppressionCount("someone-elses-customer@example.com")).toBe(1);
  });
});
