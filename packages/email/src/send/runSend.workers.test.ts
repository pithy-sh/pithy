import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { defaultTheme, type EmailTheme } from "../templates/theme";
import { enqueueEmail } from "./enqueue";
import { runSend, type SendDeps } from "./runSend";
import type { EmailMessage, EmailSender, EmailSendResult } from "./sender";
import { suppress } from "./suppression";

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
      { email: "blocked@example.com", reason: "unsubscribe" },
      now,
    );
    const { sender, sent } = fakeSender(() => ({ messageId: "should-not-send" }));

    const outcome = await runSend(sendDeps(sender), jobId);

    expect(outcome).toMatchObject({ status: "suppressed", skipped: true });
    expect(sent).toHaveLength(0);
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
