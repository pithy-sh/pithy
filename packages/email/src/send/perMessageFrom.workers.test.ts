// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { email } from "../capability";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { defaultTheme } from "../templates/theme";
import { type EnqueueDeps, type EnqueueInput, enqueueEmail } from "./enqueue";
import { runSend, type SendDeps } from "./runSend";
import type { EmailMessage, EmailSender } from "./sender";

/**
 * A per-message sender: one message sent as an address other than the capability's `fromAddress`.
 *
 * The address is never taken on trust. Only a composing capability can widen what `enqueue` may send
 * as, by naming the addresses it claims, and an override outside that list is refused before a row
 * exists. Mail sent without an override is exactly what it always was.
 */

const NOW = new Date("2026-06-18T12:00:00.000Z");
const WELCOME = { name: "Sam", ctaUrl: "https://acme.test/go", ctaLabel: "Go" };

let minted = 0;

function deps(overrides: Partial<EnqueueDeps> = {}): EnqueueDeps {
  minted += 1;
  const id = `from-${minted}`;
  return {
    db: emailDatabase(env.DB),
    fromAddress: "noreply@acme.test",
    fromName: "Acme",
    theme: defaultTheme,
    now: NOW,
    newId: () => id,
    ...overrides,
  };
}

function welcome(extra: Partial<EnqueueInput> = {}): EnqueueInput {
  return { to: "customer@example.test", template: "welcome", payload: WELCOME, ...extra };
}

async function sender(jobId: string): Promise<{ from_address: string; from_name: string } | null> {
  return await env.DB.prepare("select from_address, from_name from pithy_email_jobs where id = ?")
    .bind(jobId)
    .first<{ from_address: string; from_name: string }>();
}

async function jobCount(): Promise<number> {
  const row = await env.DB.prepare("select count(*) as n from pithy_email_jobs").first<{ n: number }>();
  return row?.n ?? 0;
}

function recordingSender(behavior: (m: EmailMessage) => void = () => undefined): {
  sender: EmailSender;
  sent: EmailMessage[];
} {
  const sent: EmailMessage[] = [];
  return {
    sent,
    sender: {
      async send(message) {
        sent.push(message);
        behavior(message);
        return { messageId: "m-1" };
      },
    },
  };
}

function sendDeps(emailSender: EmailSender): SendDeps {
  return {
    db: emailDatabase(env.DB),
    suppressionDb: emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
    sender: emailSender,
    theme: defaultTheme,
    baseUrl: "https://api.acme.test",
    signing: { key: "signing-key", kid: "1" },
    linkTtlDays: 90,
    maxAttempts: 3,
    passStartedAt: NOW,
    heartbeatAt: () => NOW,
  };
}

beforeEach(async () => {
  for (const table of ["pithy_email_jobs", "pithy_email_events"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await env.EMAIL_SUPPRESSIONS.prepare("drop table if exists pithy_email_suppressions").run();
  await email_0001_init.up(emailDatabase(env.DB));
  await email_0001_suppressions.up(emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS));
});

describe("a per-message from at enqueue", () => {
  test("a claimed address and a display name are stored on the job", async () => {
    const result = await enqueueEmail(
      deps({ claimedFrom: ["support@help.acme.test"] }),
      welcome({ from: { address: "support@help.acme.test", name: "Jim Scott" } }),
    );
    expect(await sender(result.jobId)).toEqual({ from_address: "support@help.acme.test", from_name: "Jim Scott" });
  });

  test("with no display name, the capability's fromName is kept", async () => {
    const result = await enqueueEmail(
      deps({ claimedFrom: ["support@help.acme.test"] }),
      welcome({ from: { address: "support@help.acme.test" } }),
    );
    expect(await sender(result.jobId)).toEqual({ from_address: "support@help.acme.test", from_name: "Acme" });
  });

  test("an address is matched as an address, not as a string", async () => {
    const result = await enqueueEmail(
      deps({ claimedFrom: ["support@help.acme.test"] }),
      welcome({ from: { address: "Support@Help.Acme.Test", name: "Jim Scott" } }),
    );
    expect(await sender(result.jobId)).toEqual({ from_address: "support@help.acme.test", from_name: "Jim Scott" });
  });

  test("an address outside the claimed list is refused, and no job is written", async () => {
    await expect(
      enqueueEmail(
        deps({ claimedFrom: ["support@help.acme.test"] }),
        welcome({ from: { address: "ceo@acme.test", name: "The CEO" } }),
      ),
    ).rejects.toMatchObject({ payload: { code: "email/invalid_payload" } });
    expect(await jobCount()).toBe(0);
  });

  test("with no claimed list at all, every override is refused", async () => {
    await expect(enqueueEmail(deps(), welcome({ from: { address: "noreply@acme.test" } }))).rejects.toMatchObject({
      payload: { code: "email/invalid_payload" },
    });
    expect(await jobCount()).toBe(0);
  });

  test("mail with no override is sent as the capability's identity, claimed list or not", async () => {
    const result = await enqueueEmail(deps({ claimedFrom: ["support@help.acme.test"] }), welcome());
    expect(await sender(result.jobId)).toEqual({ from_address: "noreply@acme.test", from_name: "Acme" });
  });
});

describe("the capability's seams", () => {
  const capability = email({ fromAddress: "noreply@acme.test", fromName: "Acme", baseUrl: "https://acme.test" });

  test("`enqueue` claims nothing, so a caller cannot send as an address it names", async () => {
    await expect(
      capability.enqueue(env, welcome({ from: { address: "support@help.acme.test" } })),
    ).rejects.toMatchObject({ payload: { code: "email/invalid_payload" } });
    expect(await jobCount()).toBe(0);
  });

  test("`enqueueAs` sends as an address the composing capability claims, and only those", async () => {
    const asSupport = capability.enqueueAs(["support@help.acme.test"]);
    const result = await asSupport(env, welcome({ from: { address: "support@help.acme.test", name: "Jim Scott" } }));
    expect(await sender(result.jobId)).toEqual({ from_address: "support@help.acme.test", from_name: "Jim Scott" });
    await expect(asSupport(env, welcome({ from: { address: "billing@acme.test" } }))).rejects.toMatchObject({
      payload: { code: "email/invalid_payload" },
    });
  });
});

describe("the send", () => {
  test("goes out from the job's own sender", async () => {
    const { jobId } = await enqueueEmail(
      deps({ claimedFrom: ["support@help.acme.test"] }),
      welcome({ from: { address: "support@help.acme.test", name: "Jim Scott" }, replyTo: "support@help.acme.test" }),
    );
    const { sender: fake, sent } = recordingSender();
    await runSend(sendDeps(fake), jobId);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.from).toEqual({ email: "support@help.acme.test", name: "Jim Scott" });
    expect(sent[0]?.replyTo).toBe("support@help.acme.test");
  });

  for (const code of ["E_SENDER_DOMAIN_NOT_AVAILABLE", "E_SENDER_NOT_VERIFIED"]) {
    test(`${code} fails the job naming the domain, and nothing is sent in its place`, async () => {
      const { jobId } = await enqueueEmail(
        deps({ claimedFrom: ["support@help.acme.test"] }),
        welcome({ from: { address: "support@help.acme.test", name: "Jim Scott" } }),
      );
      const { sender: fake, sent } = recordingSender(() => {
        throw { code, message: "domain not available for sending" };
      });

      const outcome = await runSend(sendDeps(fake), jobId);

      expect(outcome.status).toBe("failed");
      expect(sent).toHaveLength(1);
      expect(sent[0]?.from).toEqual({ email: "support@help.acme.test", name: "Jim Scott" });
      const row = await env.DB.prepare("select status, error, from_address from pithy_email_jobs where id = ?")
        .bind(jobId)
        .first<{ status: string; error: string; from_address: string }>();
      expect(row?.status).toBe("failed");
      expect(row?.from_address).toBe("support@help.acme.test");
      expect(row?.error).toContain(code);
      expect(row?.error).toContain("help.acme.test");
    });
  }
});
