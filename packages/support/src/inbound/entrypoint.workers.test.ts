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
 * wrapper, and must still store the message. The message is a {@link NativeLikeMessage}, whose accessors refuse a
 * foreign `this` the way a real `ForwardableEmailMessage`'s do; the database and the bucket are the real bindings.
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

describe("a Worker composing email and support", () => {
  test("stores an inbound message through createEntrypoint's email()", async () => {
    const entry = createEntrypoint({
      capabilities: [
        secrets({ registry: defineSecretRegistry({}) }),
        email({ fromAddress: "noreply@acme.test", baseUrl: "https://acme.test" }),
        support({ inboundAddresses: [INBOX], search: { fts: false }, submission: { enabled: false } }),
      ],
    });
    if (!entry.email) throw new Error("expected an email handler");

    const message = new NativeLikeMessage({
      to: INBOX,
      from: "ada@example.com",
      headers: new Headers({ subject: "Card declined" }),
      body: RAW,
    });
    // The bounce handler opens its suppression database for every message. One of Ada's never reaches a query, so
    // the app database stands in for it.
    const bindings = { DB: env.DB, EMAIL_SUPPRESSIONS: env.DB, SUPPORT_BUCKET: env.SUPPORT_BUCKET, ENVIRONMENT: "dev" };
    await entry.email(asForwardable(message), bindings, ctx);

    const db = supportDatabase(env.DB);
    const threads = await db.selectFrom(SUPPORT_THREADS_TABLE).select(["subject", "inboxAddress"]).execute();
    expect(threads).toEqual([{ subject: "Card declined", inboxAddress: INBOX }]);
    const messages = await db.selectFrom(SUPPORT_MESSAGES_TABLE).select(["mimeMessageId", "textBody"]).execute();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.mimeMessageId).toBe("composed@example.com");
    expect(messages[0]?.textBody).toContain("The payment failed twice.");
  });
});
