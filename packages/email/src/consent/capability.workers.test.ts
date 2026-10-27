// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import type { ConsentSubject } from "@pithy-sh/core/src/consent/reader";
import { beforeEach, describe, expect, test } from "vitest";
import { email } from "../capability";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { EMAIL_MARKETING_PURPOSE, EMAIL_TRACKING_PURPOSE, emailConsentGranted, emailConsentWithdrawn } from "./consent";

/**
 * The real `email()` capability under consent, not a stand-in: it declares its two purposes, hands the
 * consent capability both listeners, and its own `enqueue` asks the reader its composition provides. Delete any of
 * those wirings and a test here fails, where the enqueue-level tests in `consent.workers.test.ts` would stay green.
 */

const ada: ConsentSubject = { kind: "account", id: "ada" };

const NEWSLETTER = {
  subject: "Acme Weekly",
  intro: "This week:",
  articles: [{ title: "A", summary: "sa", link: "https://acme.test/a" }],
};

/** A consent provider answering from a fixed set of purposes, for any subject. */
const consentProvider = (granted: readonly string[]): Capability =>
  defineCapability({
    name: "consent",
    requiredBindings: [],
    consentReader: () => ({ hasConsent: async (_subject, purpose) => granted.includes(purpose) }),
  });

/** The real capability, composed beside a consent provider the way `createBackend` composes it. */
function composed(granted: readonly string[]) {
  const capability = email({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" });
  capability.compose?.({ capabilities: [capability, consentProvider(granted)] });
  return capability;
}

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

describe("the email capability under consent", () => {
  test("declares email.marketing and email.tracking, and hears both a withdrawal and a grant", () => {
    const capability = email({ fromAddress: "noreply@acme.test", baseUrl: "https://api.acme.test" });
    expect(capability.consentPurposes?.map((purpose) => purpose.id)).toEqual([
      EMAIL_MARKETING_PURPOSE,
      EMAIL_TRACKING_PURPOSE,
    ]);
    expect(capability.consentWithdrawn).toBe(emailConsentWithdrawn);
    expect(capability.consentGranted).toBe(emailConsentGranted);
  });

  test("its own enqueue withholds marketing and tracking from a subject the composed reader says no for", async () => {
    const result = await composed([]).enqueue(env, {
      to: "ada@example.test",
      template: "newsletter",
      payload: NEWSLETTER,
      consentSubject: ada,
    });
    expect(result.status).toBe("suppressed");
    expect(result.consentWithheld).toBe(EMAIL_MARKETING_PURPOSE);
    expect(await tracking(result.jobId)).toEqual({ open: 0, click: 0 });
  });

  test("and sends, untracked, to one consenting to marketing alone", async () => {
    const result = await composed([EMAIL_MARKETING_PURPOSE]).enqueue(env, {
      to: "ada@example.test",
      template: "newsletter",
      payload: NEWSLETTER,
      consentSubject: ada,
    });
    expect(result.status).toBe("undispatched");
    expect(result.consentWithheld).toBeUndefined();
    expect(await tracking(result.jobId)).toEqual({ open: 0, click: 0 });
  });
});
