// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { defaultTheme, type EmailTheme } from "../templates/theme";
import { enqueueEmail } from "./enqueue";
import { runSend, type SendDeps } from "./runSend";
import type { EmailMessage, EmailSender, EmailSendResult } from "./sender";
import { blockingSuppression, suppress } from "./suppression";

const theme: EmailTheme = { ...defaultTheme, appName: "Acme", footerAddress: "1 Market St" };

const now = new Date("2026-06-18T12:00:00.000Z");
const signing = { key: "signing-key", kid: "1" };

/** A scriptable fake of the Email Service binding. */
function fakeSender(behavior: (m: EmailMessage) => EmailSendResult | Promise<EmailSendResult>): {
  sender: EmailSender;
  sent: EmailMessage[];
} {
  const sent: EmailMessage[] = [];
  return {
    sent,
    sender: {
      async send(message) {
        sent.push(message);
        return behavior(message);
      },
    },
  };
}

function sendDeps(sender: EmailSender, overrides: Partial<SendDeps> = {}): SendDeps {
  return {
    db: emailDatabase(env.DB),
    suppressionDb: emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
    sender,
    theme,
    baseUrl: "https://api.acme.test",
    signing,
    linkTtlDays: 90,
    maxAttempts: 3,
    now,
    ...overrides,
  };
}

async function enqueue(input: Parameters<typeof enqueueEmail>[1], idSeed = "job"): Promise<string> {
  let n = 0;
  const result = await enqueueEmail(
    {
      db: emailDatabase(env.DB),
      fromAddress: "noreply@pithy.sh",
      fromName: "Acme",
      theme,
      now,
      newId: () => `${idSeed}-${++n}`,
    },
    input,
  );
  return result.jobId;
}

beforeEach(async () => {
  for (const table of ["pithy_email_jobs", "pithy_email_events"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await env.EMAIL_SUPPRESSIONS.prepare("drop table if exists pithy_email_suppressions").run();
  await email_0001_init.up(emailDatabase(env.DB));
  await email_0001_suppressions.up(emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS));
});

describe("enqueue", () => {
  test("an immediate transactional job is stored pending and validated", async () => {
    const jobId = await enqueue({
      to: "u@example.com",
      template: "welcome",
      payload: { name: "Sam", ctaUrl: "https://acme.test/go", ctaLabel: "Go" },
    });
    const row = await env.DB.prepare("select status, mode, subject, click_tracking from pithy_email_jobs where id = ?")
      .bind(jobId)
      .first<{ status: string; mode: string; subject: string; click_tracking: number }>();
    expect(row).toMatchObject({ status: "pending", mode: "immediate", subject: "Welcome to Acme", click_tracking: 0 });
  });

  test("a bad payload is rejected at enqueue, before any row is written", async () => {
    await expect(enqueue({ to: "u@example.com", template: "welcome", payload: { name: "Sam" } })).rejects.toMatchObject(
      {
        payload: { code: "email/invalid_payload" },
      },
    );
    const count = await env.DB.prepare("select count(*) as n from pithy_email_jobs").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  test("a marketing job defaults tracking on", async () => {
    const jobId = await enqueue({
      to: "u@example.com",
      template: "marketingCampaign",
      payload: { subject: "Hi", heading: "H", body: "B", ctaUrl: "https://acme.test/go", ctaLabel: "Go" },
    });
    const row = await env.DB.prepare(
      "select click_tracking, open_tracking, category from pithy_email_jobs where id = ?",
    )
      .bind(jobId)
      .first<{ click_tracking: number; open_tracking: number; category: string }>();
    expect(row).toEqual({ click_tracking: 1, open_tracking: 1, category: "marketing" });
  });
});

describe("runSend", () => {
  test("sends a job, records the messageId and a sent event", async () => {
    const jobId = await enqueue({
      to: "U@Example.com",
      template: "magicLink",
      payload: { url: "https://acme.test/s", expiresMinutes: 15 },
    });
    const { sender, sent } = fakeSender(() => ({ messageId: "msg-1" }));

    const outcome = await runSend(sendDeps(sender), jobId);

    expect(outcome).toMatchObject({ status: "sent", messageId: "msg-1" });
    expect(sent[0]?.to).toBe("u@example.com"); // normalized
    expect(sent[0]?.html).toContain("Sign in");
    const row = await env.DB.prepare("select status, message_id, attempts from pithy_email_jobs where id = ?")
      .bind(jobId)
      .first<{ status: string; message_id: string; attempts: number }>();
    expect(row).toEqual({ status: "sent", message_id: "msg-1", attempts: 1 });
    const event = await env.DB.prepare("select type from pithy_email_events where job_id = ?")
      .bind(jobId)
      .first<{ type: string }>();
    expect(event?.type).toBe("sent");
  });

  test("skips a suppressed recipient and records why", async () => {
    const jobId = await enqueue({
      to: "blocked@example.com",
      template: "welcome",
      payload: { name: "Sam", ctaUrl: "https://acme.test/go", ctaLabel: "Go" },
    });
    await suppress(
      emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      { email: "blocked@example.com", reason: "hard_bounce" },
      now,
    );
    const { sender, sent } = fakeSender(() => ({ messageId: "should-not-send" }));

    const outcome = await runSend(sendDeps(sender), jobId);

    expect(outcome).toMatchObject({ status: "suppressed", skipped: true, suppressionReason: "hard_bounce" });
    expect(sent).toHaveLength(0);
  });

  test("a skipped send names the reason on the row and the event, not just the fact", async () => {
    // The half of this bug that made it invisible. The caller saw an outcome that was not a failure and
    // the person saw an empty inbox, so neither end had anything to look at. "Suppressed" alone still
    // does not tell an operator whether to fix a typo, apologise, or leave it alone.
    const jobId = await enqueue({
      to: "gone@example.com",
      template: "welcome",
      payload: { name: "Sam", ctaUrl: "https://acme.test/go", ctaLabel: "Go" },
    });
    await suppress(
      emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      { email: "gone@example.com", reason: "complaint" },
      now,
    );
    const { sender } = fakeSender(() => ({ messageId: "should-not-send" }));

    const outcome = await runSend(sendDeps(sender), jobId);

    expect(outcome.suppressionReason).toBe("complaint");
    const row = await env.DB.prepare("select status, error from pithy_email_jobs where id = ?")
      .bind(jobId)
      .first<{ status: string; error: string }>();
    expect(row).toEqual({ status: "suppressed", error: "recipient suppressed: complaint" });
    const event = await env.DB.prepare("select type, detail from pithy_email_events where job_id = ?")
      .bind(jobId)
      .first<{ type: string; detail: string }>();
    expect(event).toEqual({ type: "suppressed", detail: "complaint" });
  });

  /**
   * The suppression matrix, end to end through a real D1 row.
   *
   * Bounce and complaint are facts about a mailbox and block everything. An unsubscribe is a statement
   * about mail somebody chose to receive, so it blocks elective mail and nothing else — the list is
   * keyed by address and holds no memory of which message was refused, and without this distinction a
   * digest opt-out silently withheld the same person's sign-in link.
   */
  describe("the suppression reason decides what it blocks", () => {
    const magicLink = {
      template: "magicLink",
      payload: { url: "https://acme.test/s", expiresMinutes: 15 },
    } as const;
    const newsletter = {
      template: "newsletter",
      payload: { subject: "N", intro: "i", articles: [] },
    } as const;

    const cases = [
      { reason: "hard_bounce", message: magicLink, label: "transactional", blocked: true },
      { reason: "complaint", message: magicLink, label: "transactional", blocked: true },
      { reason: "manual", message: magicLink, label: "transactional", blocked: true },
      { reason: "unsubscribe", message: magicLink, label: "transactional", blocked: false },
      { reason: "hard_bounce", message: newsletter, label: "elective", blocked: true },
      { reason: "complaint", message: newsletter, label: "elective", blocked: true },
      { reason: "manual", message: newsletter, label: "elective", blocked: true },
      { reason: "unsubscribe", message: newsletter, label: "elective", blocked: true },
    ] as const;

    for (const { reason, message, label, blocked } of cases) {
      test(`${reason} ${blocked ? "blocks" : "does not block"} ${label} mail`, async () => {
        const jobId = await enqueue({ to: "person@example.com", ...message }, `${reason}-${label}`);
        await suppress(emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS), { email: "person@example.com", reason }, now);
        const { sender, sent } = fakeSender(() => ({ messageId: "msg" }));

        const outcome = await runSend(sendDeps(sender), jobId);

        expect(outcome.status).toBe(blocked ? "suppressed" : "sent");
        expect(sent).toHaveLength(blocked ? 0 : 1);
      });
    }
  });

  test("an unsubscribed address still receives its magic link", async () => {
    // The case this whole change exists for, and the one that was broken and silent. Passwordless is the
    // kit's sign-in and there is no password to fall back on, so an unsubscribe — from a newsletter, a
    // digest, anything — used to make the account permanently unreachable with nothing reported anywhere.
    const suppressionDb = emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS);
    await suppress(suppressionDb, { email: "ada@example.com", reason: "unsubscribe", detail: "weekly digest" }, now);

    const jobId = await enqueue({
      to: "ada@example.com",
      template: "magicLink",
      payload: { url: "https://acme.test/sign-in?token=abc", expiresMinutes: 15 },
    });
    const { sender, sent } = fakeSender(() => ({ messageId: "msg-signin" }));

    const outcome = await runSend(sendDeps(sender), jobId);

    expect(outcome).toMatchObject({ status: "sent", messageId: "msg-signin" });
    expect(sent[0]?.to).toBe("ada@example.com");
    // The link itself, not merely a delivered envelope — this is what the person clicks to get in.
    expect(sent[0]?.text).toContain("https://acme.test/sign-in?token=abc");
    // And the opt-out stands for everything it was ever about.
    expect(await blockingSuppression(suppressionDb, "ada@example.com", now, "elective")).toBe("unsubscribe");
  });

  test("a sign-in link carries no List-Unsubscribe header and no opt-out link", async () => {
    // `List-Unsubscribe` on a login message publishes a mechanism for disabling authentication, and some
    // clients surface it as prominently as the body. Gmail's and Yahoo's rules ask for one-click opt-out
    // on *promotional* mail; this is not that.
    const jobId = await enqueue({
      to: "u@example.com",
      template: "magicLink",
      payload: { url: "https://acme.test/s", expiresMinutes: 15 },
    });
    const { sender, sent } = fakeSender(() => ({ messageId: "msg" }));

    await runSend(sendDeps(sender), jobId);

    expect(sent[0]?.headers?.["List-Unsubscribe"]).toBeUndefined();
    expect(sent[0]?.headers?.["List-Unsubscribe-Post"]).toBeUndefined();
    expect(sent[0]?.html).not.toContain("/_pithy/email/u/");
    expect(sent[0]?.text).not.toContain("/_pithy/email/u/");
  });

  test("elective mail carries the one-click unsubscribe headers, matching the link in the body", async () => {
    const jobId = await enqueue({
      to: "u@example.com",
      template: "newsletter",
      payload: { subject: "N", intro: "Hello", articles: [] },
    });
    const { sender, sent } = fakeSender(() => ({ messageId: "msg" }));

    await runSend(sendDeps(sender), jobId);

    const header = sent[0]?.headers?.["List-Unsubscribe"];
    expect(header).toMatch(/^<https:\/\/api\.acme\.test\/_pithy\/email\/u\/.+>$/);
    expect(sent[0]?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // The header is built from the URL the render actually produced, so the two can never disagree
    // about whether this message can be opted out of.
    expect(sent[0]?.html).toContain(header?.slice(1, -1));
  });

  test("a retryable failure throws until maxAttempts, then marks the job failed", async () => {
    const jobId = await enqueue({
      to: "u@example.com",
      template: "welcome",
      payload: { name: "Sam", ctaUrl: "https://acme.test/go", ctaLabel: "Go" },
    });
    const { sender } = fakeSender(() => {
      throw { code: "E_DELIVERY_FAILED", message: "smtp 451" };
    });
    const deps = sendDeps(sender, { maxAttempts: 2 });

    await expect(runSend(deps, jobId)).rejects.toMatchObject({ payload: { code: "email/send_failed" } }); // attempt 1
    const outcome = await runSend(deps, jobId); // attempt 2 — terminal
    expect(outcome.status).toBe("failed");
    const row = await env.DB.prepare("select status, attempts, error from pithy_email_jobs where id = ?")
      .bind(jobId)
      .first<{ status: string; attempts: number; error: string }>();
    expect(row).toEqual({ status: "failed", attempts: 2, error: "E_DELIVERY_FAILED" });
  });

  test("a synchronous permanent bounce on send suppresses that address", async () => {
    const jobId = await enqueue({
      to: "u@example.com",
      template: "welcome",
      payload: { name: "Sam", ctaUrl: "https://acme.test/go", ctaLabel: "Go" },
    });
    const { sender } = fakeSender(() => ({ messageId: "msg-2", permanentBounces: ["dead@example.com"] }));

    await runSend(sendDeps(sender), jobId);

    const sup = await env.EMAIL_SUPPRESSIONS.prepare("select reason from pithy_email_suppressions where email = ?")
      .bind("dead@example.com")
      .first<{ reason: string }>();
    expect(sup?.reason).toBe("hard_bounce");
  });

  test("E_RECIPIENT_SUPPRESSED suppresses the recipient locally and is terminal", async () => {
    const jobId = await enqueue({
      to: "u@example.com",
      template: "welcome",
      payload: { name: "Sam", ctaUrl: "https://acme.test/go", ctaLabel: "Go" },
    });
    const { sender } = fakeSender(() => {
      throw { code: "E_RECIPIENT_SUPPRESSED" };
    });

    const outcome = await runSend(sendDeps(sender), jobId);

    expect(outcome.status).toBe("suppressed");
    const sup = await env.EMAIL_SUPPRESSIONS.prepare(
      "select count(*) as n from pithy_email_suppressions where email = ?",
    )
      .bind("u@example.com")
      .first<{ n: number }>();
    expect(sup?.n).toBe(1);
  });

  test("a marketing job cannot send without a signing key", async () => {
    const jobId = await enqueue({
      to: "u@example.com",
      template: "marketingCampaign",
      payload: { subject: "Hi", heading: "H", body: "B", ctaUrl: "https://acme.test/go", ctaLabel: "Go" },
    });
    const { sender, sent } = fakeSender(() => ({ messageId: "x" }));

    // Terminal, not a throw — a missing signing key is a config fault; throwing would make the
    // Workflow retry forever (the failed row isn't short-circuited on re-entry).
    const outcome = await runSend(sendDeps(sender, { signing: undefined }), jobId);
    expect(outcome.status).toBe("failed");
    expect(sent).toHaveLength(0);
    const row = await env.DB.prepare("select status from pithy_email_jobs where id = ?")
      .bind(jobId)
      .first<{ status: string }>();
    expect(row?.status).toBe("failed");
  });
});
