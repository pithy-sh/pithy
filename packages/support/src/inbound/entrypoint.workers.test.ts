// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createEntrypoint } from "@pithy-sh/core/src/createEntrypoint";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { asForwardable, NativeLikeMessage } from "@pithy-sh/core/src/test-utils/nativeLikeEmail";
import { email } from "@pithy-sh/email/src/capability";
import { secrets } from "@pithy-sh/secrets/src/capability";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { beforeEach, describe, expect, test } from "vitest";
import { SUPPORT_MIGRATION_ORDER, support } from "../capability";
import { SUPPORT_MESSAGES_TABLE, SUPPORT_THREADS_TABLE, supportDatabase } from "../data/tables";
import { support_0001_threads } from "../migrations/0001_threads";

/**
 * A Worker that composes `@pithy-sh/email` and `@pithy-sh/support` has two inbound mail handlers, so
 * `createEntrypoint`'s `email()` hands each one a wrapper that replays the raw stream. Support runs second, on the
 * wrapper, and must still store the message, whatever happened to the bounce handler before it. The message is a
 * {@link NativeLikeMessage}, whose accessors refuse a foreign `this` the way a real `ForwardableEmailMessage`'s do;
 * the database and the bucket are the real bindings.
 */

const CRLF = "\r\n";
const INBOX = "support@help.acme.test";

const RAW = [
  "From: Ada Lovelace <ada@example.com>",
  `To: ${INBOX}`,
  "Subject: Card declined",
  "Message-ID: <composed@example.com>",
  "Authentication-Results: mx.cloudflare.net; dmarc=pass",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "The payment failed twice.",
].join(CRLF);

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

beforeEach(async () => {
  for (const table of [
    "pithy_support_search",
    "pithy_support_thread_flags",
    "pithy_support_classifications",
    "pithy_support_attachments",
    "pithy_support_messages",
    "pithy_support_threads",
    "pithy_migrations",
    "pithy_migrations_lock",
  ]) {
    await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "support",
      order: SUPPORT_MIGRATION_ORDER,
      migrations: { "0001_threads": support_0001_threads },
    },
  ]);
  if (!registry.app) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, registry.app);
});

/** A hard bounce delivered to the support inbox: the bounce handler acts on it, and support stores it. */
const DSN = [
  "From: Mail Delivery <mailer-daemon@acme.test>",
  `To: ${INBOX}`,
  "Subject: Delivery Status Notification (Failure)",
  "Message-ID: <dsn@acme.test>",
  "Authentication-Results: mx.cloudflare.net; dmarc=pass",
  "Content-Type: multipart/report; report-type=delivery-status; boundary=b",
  "",
  "--b",
  "Content-Type: text/plain",
  "",
  "Your message could not be delivered.",
  "--b",
  "Content-Type: message/delivery-status",
  "",
  "Original-Message-ID: <sent@acme.test>",
  "Final-Recipient: rfc822;u@example.com",
  "Action: failed",
  "Status: 5.1.1",
  "--b--",
  "",
].join(CRLF);

/** A D1 binding whose every statement fails, the way one does when the database is unreachable. */
const failingD1 = {
  prepare() {
    throw new Error("D1_ERROR: database unavailable");
  },
  batch() {
    throw new Error("D1_ERROR: database unavailable");
  },
};

/** Deliver `raw` to a Worker composing secrets, email and support, the way Email Routing does. */
async function deliver(raw: string, bindings: Record<string, unknown>): Promise<void> {
  const entry = createEntrypoint({
    capabilities: [
      secrets({ registry: defineSecretRegistry({}) }),
      email({ fromAddress: "noreply@acme.test", baseUrl: "https://acme.test" }),
      support({ inboundAddresses: [INBOX], search: { fts: false }, submission: { enabled: false } }),
    ],
  });
  if (!entry.email) throw new Error("expected an email handler");
  const message = new NativeLikeMessage({ to: INBOX, from: "ada@example.com", headers: new Headers(), body: raw });
  await entry.email(asForwardable(message), bindings, ctx);
}

/** Every stored message, as subject and Message-ID. */
async function stored(): Promise<{ subject: string | null; mimeMessageId: string | null }[]> {
  const db = supportDatabase(env.DB);
  const threads = await db.selectFrom(SUPPORT_THREADS_TABLE).select(["id", "subject"]).execute();
  const messages = await db.selectFrom(SUPPORT_MESSAGES_TABLE).select(["threadId", "mimeMessageId"]).execute();
  return messages.map((m) => ({
    subject: threads.find((t) => t.id === m.threadId)?.subject ?? null,
    mimeMessageId: m.mimeMessageId ?? null,
  }));
}

describe("a Worker composing email and support", () => {
  test("stores an inbound message through createEntrypoint's email(), with no EMAIL_SUPPRESSIONS bound", async () => {
    await deliver(RAW, { DB: env.DB, SUPPORT_BUCKET: env.SUPPORT_BUCKET, ENVIRONMENT: "dev" });

    const db = supportDatabase(env.DB);
    const threads = await db.selectFrom(SUPPORT_THREADS_TABLE).select(["subject", "inboxAddress"]).execute();
    expect(threads).toEqual([{ subject: "Card declined", inboxAddress: INBOX }]);
    const messages = await db.selectFrom(SUPPORT_MESSAGES_TABLE).select(["mimeMessageId", "textBody"]).execute();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.mimeMessageId).toBe("composed@example.com");
    expect(messages[0]?.textBody).toContain("The payment failed twice.");
  });

  test("stores a message the bounce handler fails on, and the failure is logged", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      await deliver(DSN, {
        DB: env.DB,
        EMAIL_SUPPRESSIONS: failingD1,
        SUPPORT_BUCKET: env.SUPPORT_BUCKET,
        ENVIRONMENT: "dev",
      });
    } finally {
      console.log = original;
    }

    expect(await stored()).toEqual([
      { subject: "Delivery Status Notification (Failure)", mimeMessageId: "dsn@acme.test" },
    ]);
    const failed = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l.level === "error");
    expect(failed).toEqual([
      expect.objectContaining({
        name: "email",
        fields: expect.objectContaining({ error: expect.objectContaining({ message: expect.any(String) }) }),
      }),
    ]);
  });
});
