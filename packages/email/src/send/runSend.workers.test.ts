// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { LocaleCatalogs } from "@pithy-sh/core/src/i18n/catalog";
import { beforeEach, describe, expect, test } from "vitest";
import { SPENT_PAYLOAD } from "../data/emailJob";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { retryJob } from "../jobs/retry";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { catalogLayers } from "../templates/messages";
import { defaultTheme, type EmailTheme } from "../templates/theme";
import { type EnqueueResult, enqueueEmail } from "./enqueue";
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
    passStartedAt: now,
    heartbeatAt: () => now,
    ...overrides,
  };
}

/**
 * A second language, as a project would compose one.
 *
 * The catalogs reach `@pithy-sh/email` as **data** — `layersFor`, filled by a composed `i18n`
 * capability in the app worker and by the `EMAIL_MESSAGES` var in the standalone host. This package
 * imports no i18n capability, so the test writes the sentences rather than reaching for the shipped
 * Spanish, which would be asserting a dependency that must not exist.
 */
const CATALOGS: LocaleCatalogs = {
  es: {
    "email/welcome.subject": "Te damos la bienvenida a {app}",
    "email/welcome.heading": "Te damos la bienvenida a {app}",
    "email/welcome.body": "Hola {name}: te damos la bienvenida a {app}.",
  },
};

async function enqueueResult(
  input: Parameters<typeof enqueueEmail>[1],
  idSeed = "job",
  layersFor = catalogLayers(CATALOGS),
): Promise<EnqueueResult> {
  let n = 0;
  return await enqueueEmail(
    {
      db: emailDatabase(env.DB),
      fromAddress: "noreply@pithy.sh",
      fromName: "Acme",
      theme,
      layersFor,
      now,
      newId: () => `${idSeed}-${++n}`,
    },
    input,
  );
}

/** The id alone, which is all almost every test below needs. */
async function enqueue(...args: Parameters<typeof enqueueResult>): Promise<string> {
  return (await enqueueResult(...args)).jobId;
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
  // This harness composes no send Workflow binding, so an immediate job is born `undispatched` —
  // nothing is coming for it (pithy-sh/pithy#410). Everything below is about what the write path
  // *stored*, which is unchanged.
  test("an immediate transactional job is stored undispatched and validated", async () => {
    const jobId = await enqueue({
      to: "u@example.com",
      template: "welcome",
      payload: { name: "Sam", ctaUrl: "https://acme.test/go", ctaLabel: "Go" },
    });
    const row = await env.DB.prepare("select status, mode, subject, click_tracking from pithy_email_jobs where id = ?")
      .bind(jobId)
      .first<{ status: string; mode: string; subject: string; click_tracking: number }>();
    expect(row).toMatchObject({
      status: "undispatched",
      mode: "immediate",
      subject: "Welcome to Acme",
      click_tracking: 0,
    });
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
    // does not tell an operator whether to fix a typo, apologize, or leave it alone.
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

  test("a terminal send code is never thrown, so no step ever retries it", async () => {
    // The half `send/retryPolicy.ts` leans on: a validation/sender/content code is terminal in
    // `classifySendError`, and this branch is what keeps it away from the durable step at all. Both
    // codes carry `email/send_failed`, so if this ever threw, the step would retry a rejected sender
    // address until the budget ran out (pithy-sh/pithy#338).
    const jobId = await enqueue({
      to: "u@example.com",
      template: "welcome",
      payload: { name: "Sam", ctaUrl: "https://acme.test/go", ctaLabel: "Go" },
    });
    const { sender } = fakeSender(() => {
      throw { code: "E_INVALID_SENDER", message: "sender not verified" };
    });

    const outcome = await runSend(sendDeps(sender, { maxAttempts: 3 }), jobId);

    expect(outcome.status).toBe("failed");
    const row = await env.DB.prepare("select status, attempts, error from pithy_email_jobs where id = ?")
      .bind(jobId)
      .first<{ status: string; attempts: number; error: string }>();
    expect(row).toEqual({ status: "failed", attempts: 1, error: "E_INVALID_SENDER" });
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

  /**
   * A delivered job holds no live credential — the property, on the kit's own mail, against real D1.
   *
   * `enqueueEmail` writes the caller's payload into the row verbatim and nothing ever deleted a job, so
   * every link the kit has ever mailed stayed in plaintext for the life of the table. An adopter
   * storing an invitation token as a digest then mailed the plaintext into this table, and the digest
   * bought nothing. The fix has one hard constraint — a payload dropped before the last attempt is a
   * message that cannot be resent — so these tests are as much about what is *kept* as what is dropped.
   */
  describe("a delivered job's inputs are spent", () => {
    const TOKEN = "eyJhbGciOiJIUzI1NiJ9.super-secret-sign-in-token";
    const magicLinkUrl = `https://acme.test/sign-in?token=${TOKEN}`;

    /** Every column of a job row, as text, so a token surviving anywhere in it is a failure. */
    async function wholeRow(jobId: string): Promise<string> {
      const row = await env.DB.prepare("select * from pithy_email_jobs where id = ?").bind(jobId).first();
      return JSON.stringify(row);
    }

    test("a delivered magic-link job holds no token", async () => {
      const jobId = await enqueue({
        to: "ada@example.com",
        template: "magicLink",
        payload: { url: magicLinkUrl, expiresMinutes: 15 },
      });
      // Enqueued, it does — the send Workflow renders from this row, so there is nowhere else for the
      // link to live in the meantime.
      expect(await wholeRow(jobId)).toContain(TOKEN);

      const { sender, sent } = fakeSender(() => ({ messageId: "msg-signin" }));
      const outcome = await runSend(sendDeps(sender), jobId);

      // The person got the working link…
      expect(outcome.status).toBe("sent");
      expect(sent[0]?.text).toContain(magicLinkUrl);
      // …and the database kept no copy of it, in any column.
      expect(await wholeRow(jobId)).not.toContain(TOKEN);
      expect(await wholeRow(jobId)).not.toContain("sign-in?token");
    });

    test("what an operator needs survives: was this sent, to whom, when, did it arrive", async () => {
      const jobId = await enqueue({
        to: "ada@example.com",
        template: "magicLink",
        payload: { url: magicLinkUrl, expiresMinutes: 15 },
      });
      const { sender } = fakeSender(() => ({ messageId: "msg-signin" }));
      await runSend(sendDeps(sender), jobId);

      const row = await env.DB.prepare(
        "select to_address, subject, status, sent_at, message_id, payload, payload_redacted_at from pithy_email_jobs where id = ?",
      )
        .bind(jobId)
        .first<Record<string, unknown>>();
      expect(row).toEqual({
        to_address: "ada@example.com",
        subject: "Your sign-in link",
        status: "sent",
        sent_at: now.getTime(),
        message_id: "msg-signin",
        // Emptied, and stamped. The stamp is what distinguishes a job whose variables were spent from
        // one enqueued with none — an operator reading a blank render needs to tell those apart.
        payload: SPENT_PAYLOAD,
        payload_redacted_at: now.getTime(),
      });
      const event = await env.DB.prepare("select type from pithy_email_events where job_id = ?")
        .bind(jobId)
        .first<{ type: string }>();
      expect(event?.type).toBe("sent");
    });

    test("a payload survives a retryable failure, because another attempt is coming", async () => {
      // "Spent" means after the last attempt this job will ever make, not after the first. A payload
      // dropped here is a message that cannot be resent — a worse failure than the one being fixed.
      const jobId = await enqueue({
        to: "ada@example.com",
        template: "magicLink",
        payload: { url: magicLinkUrl, expiresMinutes: 15 },
      });
      let fail = true;
      const { sender, sent } = fakeSender(() => {
        if (fail) throw { code: "E_DELIVERY_FAILED", message: "smtp 451" };
        return { messageId: "msg-eventually" };
      });
      const deps = sendDeps(sender, { maxAttempts: 3 });

      await expect(runSend(deps, jobId)).rejects.toMatchObject({ payload: { code: "email/send_failed" } });
      expect(await wholeRow(jobId)).toContain(TOKEN);

      fail = false;
      expect((await runSend(deps, jobId)).status).toBe("sent");
      // The second attempt rendered the real link, which is the whole proof: the inputs were still there.
      expect(sent[0]?.text).toContain(magicLinkUrl);
      expect(await wholeRow(jobId)).not.toContain(TOKEN);
    });

    test("a terminally failed job keeps its payload, and an operator's retry still sends the real link", async () => {
      const jobId = await enqueue({
        to: "ada@example.com",
        template: "magicLink",
        payload: { url: magicLinkUrl, expiresMinutes: 15 },
      });
      let fail = true;
      const { sender, sent } = fakeSender(() => {
        if (fail) throw { code: "E_DELIVERY_FAILED", message: "smtp 451" };
        return { messageId: "msg-retried" };
      });
      const deps = sendDeps(sender, { maxAttempts: 1 });

      expect((await runSend(deps, jobId)).status).toBe("failed");
      expect(await wholeRow(jobId)).toContain(TOKEN);

      // `POST /email/jobs/:id/retry` — the operator-facing path, which only exists for a failed job and
      // is exactly why a failed job may not be redacted.
      fail = false;
      await retryJob(
        { db: emailDatabase(env.DB), suppressionDb: emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS), now },
        jobId,
      );
      expect((await runSend(deps, jobId)).status).toBe("sent");
      expect(sent.at(-1)?.text).toContain(magicLinkUrl);
      expect(await wholeRow(jobId)).not.toContain(TOKEN);
    });

    test("a suppressed job keeps its payload — the message never went out, and the block can be lifted", async () => {
      await suppress(
        emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
        { email: "blocked@example.com", reason: "manual" },
        now,
      );
      const jobId = await enqueue({
        to: "blocked@example.com",
        template: "magicLink",
        payload: { url: magicLinkUrl, expiresMinutes: 15 },
      });
      const { sender } = fakeSender(() => ({ messageId: "never" }));

      expect((await runSend(sendDeps(sender), jobId)).status).toBe("suppressed");
      expect(await wholeRow(jobId)).toContain(TOKEN);
    });

    test("a marketing job keeps its payload, which is the copy and not a credential", async () => {
      // The deliberate exception, and the line is the category rather than the kind: a marketing
      // payload is copy authored for a batch, and "what did those forty thousand people receive" is a
      // real question. Every transactional template's payload is one person's one-time input.
      const jobId = await enqueue({
        to: "u@example.com",
        template: "marketingCampaign",
        payload: { subject: "Hi", heading: "H", body: "Body copy.", ctaUrl: "https://acme.test/go", ctaLabel: "Go" },
      });
      const { sender } = fakeSender(() => ({ messageId: "msg-campaign" }));

      expect((await runSend(sendDeps(sender), jobId)).status).toBe("sent");
      const row = await env.DB.prepare("select payload, payload_redacted_at from pithy_email_jobs where id = ?")
        .bind(jobId)
        .first<{ payload: string; payload_redacted_at: number | null }>();
      expect(row?.payload).toContain("Body copy.");
      expect(row?.payload_redacted_at).toBeNull();
    });

    test("the elective template whose payload does authenticate somebody is redacted anyway", async () => {
      // `testerNudge` is the template that proves consent and credential-bearing are different axes. It
      // is elective — somebody may say stop chasing me — and its CTA is an opt-in URL that authenticates
      // a tester. Keying redaction on the kind would have left exactly this one live.
      const optIn = "https://acme.test/testers/opt-in/tester-token-9f2";
      const jobId = await enqueue({
        to: "tester@example.com",
        template: "testerNudge",
        payload: { subject: "One step left", heading: "Confirm", paragraphs: ["Please confirm."], ctaUrl: optIn },
      });
      const { sender } = fakeSender(() => ({ messageId: "msg-nudge" }));

      expect((await runSend(sendDeps(sender), jobId)).status).toBe("sent");
      expect(await wholeRow(jobId)).not.toContain("tester-token-9f2");
    });

    test("a job that somehow lost its payload fails terminally instead of mailing an empty message", async () => {
      // Unreachable today: only a `sent` job is redacted, and `sent` short-circuits before this. The
      // guard is here because the invariant is worth more executable than commented — and because the
      // failure it prevents is a real person receiving a magic-link email with no link in it.
      const jobId = await enqueue({
        to: "ada@example.com",
        template: "magicLink",
        payload: { url: magicLinkUrl, expiresMinutes: 15 },
      });
      await env.DB.prepare("update pithy_email_jobs set payload = ?, payload_redacted_at = ? where id = ?")
        .bind(SPENT_PAYLOAD, now.getTime(), jobId)
        .run();
      const { sender, sent } = fakeSender(() => ({ messageId: "should-not-send" }));

      const outcome = await runSend(sendDeps(sender), jobId);

      expect(outcome.status).toBe("failed");
      expect(sent).toHaveLength(0);
      const row = await env.DB.prepare("select error from pithy_email_jobs where id = ?")
        .bind(jobId)
        .first<{ error: string }>();
      expect(row?.error).toBe("payload dropped after delivery");
    });
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

/**
 * The recipient's language, from the enqueue that knew them to the send that does not.
 *
 * The two render sites are in different Workers at different times — `renderSubject` inside a request
 * handler, `renderEmail` inside a Workflow hours later — and until the tag was on the row the only
 * thing making them agree was that both defaulted to English. These are the tests that say they agree
 * because of the column.
 */
describe("a job carries its language from the enqueue to the send", () => {
  test("the subject is stored in the recipient's language, and the body arrives in it too", async () => {
    const jobId = await enqueue({
      to: "u@example.com",
      template: "welcome",
      payload: { name: "Sam", ctaUrl: "https://acme.test/go", ctaLabel: "Go" },
      locale: "es",
    });

    const stored = await env.DB.prepare("select subject, locale from pithy_email_jobs where id = ?")
      .bind(jobId)
      .first<{ subject: string; locale: string | null }>();
    expect(stored).toEqual({ subject: "Te damos la bienvenida a Acme", locale: "es" });

    const { sender, sent } = fakeSender(() => ({ messageId: "m-es" }));
    await runSend(sendDeps(sender, { layersFor: catalogLayers(CATALOGS) }), jobId);

    expect(sent[0]?.subject).toBe("Te damos la bienvenida a Acme");
    expect(sent[0]?.html).toContain("Hola Sam: te damos la bienvenida a Acme.");
    // The shell declares the language it is written in. There was no `dir` in it at all before
    // pithy-sh/pithy#441.
    expect(sent[0]?.html).toContain('<html lang="es" dir="ltr"');
  });

  test("a job that chose no language sends the kit's English, exactly as before", async () => {
    const jobId = await enqueue({
      to: "v@example.com",
      template: "welcome",
      payload: { name: "Sam", ctaUrl: "https://acme.test/go", ctaLabel: "Go" },
    });

    const { sender, sent } = fakeSender(() => ({ messageId: "m-en" }));
    await runSend(sendDeps(sender, { layersFor: catalogLayers(CATALOGS) }), jobId);

    expect(sent[0]?.subject).toBe("Welcome to Acme");
    expect(sent[0]?.html).toContain('<html lang="en" dir="ltr"');
  });

  test("the delivered subject is the send's own render, not the one enqueue answered with", async () => {
    // `runSend` sends a *fresh* render rather than `job.subject`, so the column was only ever the
    // enqueue's guess. A catalog sentence retranslated between the queue and the send used to leave the
    // send log describing a message nobody received; now the row is rewritten from what went out.
    //
    // **And this is the boundary on `EnqueueResult.subject` (pithy-sh/pithy#443).** That field is the
    // enqueue-time render — what a caller queued, and what its audit row can say it queued. It is not a
    // promise about the delivered sentence, and a scheduled send whose catalog moved underneath it is
    // where the two part company. Prose said so; this says so in a way that fails when it stops being
    // true.
    const enqueued = await enqueueResult({
      to: "w@example.com",
      template: "welcome",
      payload: { name: "Sam", ctaUrl: "https://acme.test/go", ctaLabel: "Go" },
      locale: "es",
    });

    const retranslated: LocaleCatalogs = { es: { "email/welcome.subject": "Bienvenido a {app}" } };
    const { sender, sent } = fakeSender(() => ({ messageId: "m-drift" }));
    await runSend(sendDeps(sender, { layersFor: catalogLayers(retranslated) }), enqueued.jobId);

    const row = await env.DB.prepare("select subject from pithy_email_jobs where id = ?")
      .bind(enqueued.jobId)
      .first<{ subject: string }>();
    expect(sent[0]?.subject).toBe("Bienvenido a Acme");
    expect(row?.subject).toBe(sent[0]?.subject);
    // What the caller was handed at enqueue, unchanged by any of that — and no longer the row's.
    expect(enqueued.subject).toBe("Te damos la bienvenida a Acme");
    expect(enqueued.subject).not.toBe(row?.subject);
  });
});
