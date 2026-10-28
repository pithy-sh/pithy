// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { ConsentReader, ConsentSubject } from "@pithy-sh/core/src/consent/reader";
import { beforeEach, describe, expect, test } from "vitest";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { type EnqueueDeps, type EnqueueInput, enqueueEmail } from "../send/enqueue";
import { blockingSuppression } from "../send/suppression";
import { defaultTheme } from "../templates/theme";
import { EMAIL_MARKETING_PURPOSE, EMAIL_TRACKING_PURPOSE, emailConsentGranted, emailConsentWithdrawn } from "./consent";

/**
 * Email under consent, on real D1: with consent composed, a marketing template goes only to a subject
 * consenting to `email.marketing`, opens and clicks are tracked only for one consenting to `email.tracking`, and a
 * transactional message is never gated. Without consent composed, nothing changes. And a withdrawal reaches the
 * suppression list and the queue.
 */

const NEWSLETTER = {
  subject: "Acme Weekly",
  intro: "This week:",
  articles: [{ title: "A", summary: "sa", link: "https://acme.test/a" }],
};
const INVITE = { inviterName: "Sam", organizationName: "Acme", acceptUrl: "https://acme.test/accept" };

const ada: ConsentSubject = { kind: "account", id: "ada" };

/** A reader answering from a fixed set of `subject:purpose` grants. */
function reader(granted: string[]): ConsentReader {
  return { hasConsent: async (subject, purpose) => granted.includes(`${subject.id}:${purpose}`) };
}

let minted = 0;
function deps(consent?: ConsentReader | null): EnqueueDeps {
  minted += 1;
  const id = `job-${minted}`;
  return {
    db: emailDatabase(env.DB),
    fromAddress: "noreply@acme.test",
    fromName: "Acme",
    theme: defaultTheme,
    suppressionDb: emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
    consent,
    now: new Date("2026-10-27T12:00:00.000Z"),
    newId: () => id,
  };
}

const newsletter = (consentSubject?: ConsentSubject): EnqueueInput => ({
  to: "ada@example.test",
  template: "newsletter",
  payload: NEWSLETTER,
  ...(consentSubject ? { consentSubject } : {}),
});

async function tracking(jobId: string): Promise<{ open: number; click: number }> {
  const row = await env.DB.prepare(
    "select open_tracking as open, click_tracking as click from pithy_email_jobs where id = ?",
  )
    .bind(jobId)
    .first<{ open: number; click: number }>();
  return row ?? { open: -1, click: -1 };
}

beforeEach(async () => {
  for (const table of ["pithy_email_jobs", "pithy_email_events"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await env.EMAIL_SUPPRESSIONS.prepare("drop table if exists pithy_email_suppressions").run();
  await email_0001_init.up(emailDatabase(env.DB));
  await email_0001_suppressions.up(emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS));
});

describe("with consent composed", () => {
  test("a marketing template goes to a consenting subject, tracked only with tracking consent", async () => {
    const both = await enqueueEmail(
      deps(reader([`ada:${EMAIL_MARKETING_PURPOSE}`, `ada:${EMAIL_TRACKING_PURPOSE}`])),
      newsletter(ada),
    );
    expect(both.status).toBe("undispatched");
    expect(both.consentWithheld).toBeUndefined();
    expect(await tracking(both.jobId)).toEqual({ open: 1, click: 1 });

    const untracked = await enqueueEmail(deps(reader([`ada:${EMAIL_MARKETING_PURPOSE}`])), newsletter(ada));
    expect(untracked.consentWithheld).toBeUndefined();
    expect(await tracking(untracked.jobId)).toEqual({ open: 0, click: 0 });
  });

  test("a marketing template to a subject not consenting, or to no subject, is withheld and on the record", async () => {
    for (const subject of [ada, undefined]) {
      const result = await enqueueEmail(deps(reader([])), newsletter(subject));
      expect(result.status).toBe("suppressed");
      expect(result.consentWithheld).toBe(EMAIL_MARKETING_PURPOSE);
      const event = await env.DB.prepare("select detail from pithy_email_events where job_id = ?")
        .bind(result.jobId)
        .first<{ detail: string }>();
      expect(event?.detail).toBe(`consent:${EMAIL_MARKETING_PURPOSE}`);
    }
  });

  test("a transactional message is never gated, and tracks only with consent", async () => {
    const result = await enqueueEmail(deps(reader([])), {
      to: "ada@example.test",
      template: "invite",
      payload: INVITE,
      consentSubject: ada,
      openTracking: true,
      clickTracking: true,
    });
    expect(result.status).toBe("undispatched");
    expect(result.consentWithheld).toBeUndefined();
    expect(await tracking(result.jobId)).toEqual({ open: 0, click: 0 });
  });
});

describe("without consent composed", () => {
  test("email behaves as it always has: marketing sends and tracks", async () => {
    for (const consent of [undefined, null]) {
      const result = await enqueueEmail(deps(consent), newsletter());
      expect(result.status).toBe("undispatched");
      expect(await tracking(result.jobId)).toEqual({ open: 1, click: 1 });
    }
  });
});

describe("a withdrawal", () => {
  const withdrawal = (purpose: string, address: string | null) => ({
    subject: ada,
    purpose,
    env: env as unknown as Record<string, unknown>,
    address: async () => address,
  });

  test("from marketing suppresses the address for marketing, and never for a sign-in", async () => {
    await emailConsentWithdrawn(withdrawal(EMAIL_MARKETING_PURPOSE, "Ada@Example.test"));
    const db = emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS);
    const now = new Date();
    expect(await blockingSuppression(db, "ada@example.test", now, "elective")).toBe("unsubscribe");
    expect(await blockingSuppression(db, "ada@example.test", now, "transactional")).toBeNull();
  });

  test("from marketing never downgrades a stronger suppression", async () => {
    const db = emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS);
    await db
      .insertInto("pithyEmailSuppressions")
      .values({ email: "ada@example.test", reason: "hard_bounce", createdAt: Date.now() })
      .execute();
    await emailConsentWithdrawn(withdrawal(EMAIL_MARKETING_PURPOSE, "ada@example.test"));
    expect(await blockingSuppression(db, "ada@example.test", new Date(), "transactional")).toBe("hard_bounce");
  });

  test("from marketing replaces a lapsed time-boxed suppression with its own, permanent one", async () => {
    const db = emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS);
    const now = new Date();
    await db
      .insertInto("pithyEmailSuppressions")
      .values({ email: "ada@example.test", reason: "manual", expiresAt: now.getTime() - 60_000, createdAt: 0 })
      .execute();
    await emailConsentWithdrawn(withdrawal(EMAIL_MARKETING_PURPOSE, "ada@example.test"));
    expect(await blockingSuppression(db, "ada@example.test", now, "elective")).toBe("unsubscribe");
    expect(await blockingSuppression(db, "ada@example.test", now, "transactional")).toBeNull();
    // The row is the withdrawal's own now, so a later grant lifts it.
    await emailConsentGranted(withdrawal(EMAIL_MARKETING_PURPOSE, "ada@example.test"));
    expect(await blockingSuppression(db, "ada@example.test", now, "elective")).toBeNull();
  });

  test("from marketing outlasts a live time-boxed unsubscribe", async () => {
    const db = emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS);
    const now = new Date();
    await db
      .insertInto("pithyEmailSuppressions")
      .values({ email: "ada@example.test", reason: "unsubscribe", expiresAt: now.getTime() + 60_000, createdAt: 0 })
      .execute();
    await emailConsentWithdrawn(withdrawal(EMAIL_MARKETING_PURPOSE, "ada@example.test"));
    const later = new Date(now.getTime() + 3_600_000);
    expect(await blockingSuppression(db, "ada@example.test", later, "elective")).toBe("unsubscribe");
  });

  test("from marketing keeps a live time-boxed stronger suppression, and makes it permanent", async () => {
    const db = emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS);
    const now = new Date();
    await db
      .insertInto("pithyEmailSuppressions")
      .values({ email: "ada@example.test", reason: "hard_bounce", expiresAt: now.getTime() + 60_000, createdAt: 0 })
      .execute();
    await emailConsentWithdrawn(withdrawal(EMAIL_MARKETING_PURPOSE, "ada@example.test"));
    expect(await blockingSuppression(db, "ada@example.test", now, "transactional")).toBe("hard_bounce");
    const later = new Date(now.getTime() + 3_600_000);
    expect(await blockingSuppression(db, "ada@example.test", later, "elective")).toBe("hard_bounce");
  });

  test("from tracking stops tracking on mail already queued to the address", async () => {
    const queued = await enqueueEmail(deps(), newsletter());
    expect(await tracking(queued.jobId)).toEqual({ open: 1, click: 1 });
    await emailConsentWithdrawn(withdrawal(EMAIL_TRACKING_PURPOSE, "ada@example.test"));
    expect(await tracking(queued.jobId)).toEqual({ open: 0, click: 0 });
  });

  test("with no address to act on does nothing", async () => {
    await emailConsentWithdrawn(withdrawal(EMAIL_MARKETING_PURPOSE, null));
    const rows = await env.EMAIL_SUPPRESSIONS.prepare("select count(*) as n from pithy_email_suppressions").first<{
      n: number;
    }>();
    expect(rows?.n).toBe(0);
  });
});

describe("a grant after a withdrawal", () => {
  const choice = (purpose: string, address: string | null) => ({
    subject: ada,
    purpose,
    env: env as unknown as Record<string, unknown>,
    address: async () => address,
  });

  test("to marketing lifts the suppression the withdrawal wrote, so marketing mail goes again", async () => {
    await emailConsentWithdrawn(choice(EMAIL_MARKETING_PURPOSE, "ada@example.test"));
    const withheld = await enqueueEmail(deps(reader([`ada:${EMAIL_MARKETING_PURPOSE}`])), newsletter(ada));
    expect(withheld.status).toBe("suppressed");

    await emailConsentGranted(choice(EMAIL_MARKETING_PURPOSE, "Ada@Example.test"));
    const sent = await enqueueEmail(deps(reader([`ada:${EMAIL_MARKETING_PURPOSE}`])), newsletter(ada));
    expect(sent.status).toBe("undispatched");
  });

  test("never lifts a bounce, a complaint, or an unsubscribe the withdrawal did not write", async () => {
    const db = emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS);
    const rows = [
      { email: "bounce@example.test", reason: "hard_bounce" as const, detail: null },
      { email: "complaint@example.test", reason: "complaint" as const, detail: null },
      { email: "link@example.test", reason: "unsubscribe" as const, detail: "one-click unsubscribe" },
      { email: "manual@example.test", reason: "manual" as const, detail: null },
    ];
    for (const row of rows) {
      await db
        .insertInto("pithyEmailSuppressions")
        .values({ ...row, createdAt: Date.now() })
        .execute();
      await emailConsentGranted(choice(EMAIL_MARKETING_PURPOSE, row.email));
      expect(await blockingSuppression(db, row.email, new Date(), "elective"), row.email).toBe(row.reason);
    }
  });

  test("to tracking, or with no address, lifts nothing", async () => {
    await emailConsentWithdrawn(choice(EMAIL_MARKETING_PURPOSE, "ada@example.test"));
    await emailConsentGranted(choice(EMAIL_TRACKING_PURPOSE, "ada@example.test"));
    await emailConsentGranted(choice(EMAIL_MARKETING_PURPOSE, null));
    const db = emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS);
    expect(await blockingSuppression(db, "ada@example.test", new Date(), "elective")).toBe("unsubscribe");
  });
});
