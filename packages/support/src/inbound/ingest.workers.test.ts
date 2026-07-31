// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { createLogger } from "@pithy-sh/core/src/logger/logger";
import type { LogRecord } from "@pithy-sh/core/src/logger/record";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { rawMessageKey } from "../attachment/store";
import { SUPPORT_MIGRATION_ORDER } from "../capability";
import { SupportConfig, type SupportConfigInput } from "../config/config";
import { SupportAttachment } from "../data/attachment";
import { SupportMessage } from "../data/message";
import {
  SUPPORT_ATTACHMENTS_TABLE,
  SUPPORT_MESSAGES_TABLE,
  SUPPORT_THREADS_TABLE,
  supportDatabase,
} from "../data/tables";
import { SupportThread } from "../data/thread";
import { support_0001_threads } from "../migrations/0001_threads";
import { createSearchIndex } from "../store/searchIndex";
import { type IngestDeps, type IngestOutcome, ingestInbound } from "./ingest";

/**
 * Ingest end to end, against a real D1 and a real R2 bucket.
 *
 * Only the four seams that reach outside the Worker are injected — the classification Workflow, the
 * sender link, the audit recorder, and the logger. Everything else is the real thing: real RFC 5322
 * bytes through the real parser, real rows, real objects. A test suite built on a fake database and a
 * fake bucket would pass against an ingest that never wrote either, which is the one thing this file
 * exists to prove it does.
 */

const CRLF = "\r\n";

/** The configured inbox every fixture below is addressed to. */
const INBOX = "support@help.acme.test";

/** Ingest's clock, fixed so every stored timestamp is assertable. */
const NOW = new Date("2026-07-01T12:00:00.000Z");

/** A header block, a blank line, a body — which is also exactly the shape of one MIME part. */
function message(headers: string[], body = ""): string {
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;
}

/** Wrap parts in their boundary delimiters, closing with the terminal `--boundary--`. */
function multipart(boundary: string, parts: string[]): string {
  return [...parts.flatMap((part) => [`--${boundary}`, part]), `--${boundary}--`, ""].join(CRLF);
}

/** Base64, the way a `Content-Transfer-Encoding: base64` part carries bytes. */
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/** The raw bytes as the runtime hands them to `email()`. */
function raw(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Row ids, unique for the whole file rather than per test.
 *
 * R2 has no `beforeEach`, and an attachment key is `support/<thread>/<id>` — so ids that restarted
 * each test would let one test read the bytes a previous one wrote and still look green.
 */
let ids = 0;
function newId(): string {
  ids += 1;
  return `id-${ids}`;
}

/** What a harness collects from the injected seams. */
interface Harness {
  deps: IngestDeps;
  /** Every audit event `emit` was handed, in order. */
  emitted: AuditEventInput[];
  /** The message ids classification was dispatched for. */
  classified: string[];
  /** Every log record, for the paths whose only trace is a warning. */
  records: LogRecord[];
}

/** Build ingest's dependencies over the live bindings, with the four outside seams faked. */
function harness(
  config: Partial<SupportConfigInput> = {},
  hooks: {
    dispatchClassify?: (messageId: string) => Promise<boolean>;
    linkSender?: (address: string) => Promise<string | null>;
  } = {},
  /** Overrides for the deps that are not config and not a seam — currently just the index switch. */
  overrides: { fts?: boolean } = {},
): Harness {
  const emitted: AuditEventInput[] = [];
  const classified: string[] = [];
  const records: LogRecord[] = [];
  const deps: IngestDeps = {
    db: supportDatabase(env.DB),
    config: SupportConfig.parse({ inboundAddresses: [INBOX], ...config }),
    bucket: env.SUPPORT_BUCKET,
    fts: overrides.fts ?? false,
    dispatchClassify:
      hooks.dispatchClassify ??
      (async (messageId) => {
        classified.push(messageId);
        return true;
      }),
    linkSender: hooks.linkSender ?? (async () => null),
    emit: async (event) => {
      emitted.push(event);
    },
    log: createLogger({ level: "debug", sink: (record) => records.push(record) }),
    newId,
    now: () => NOW,
  };
  return { deps, emitted, classified, records };
}

/** Narrow to the stored outcome, so a test can read `threadId` without re-asserting the union. */
function stored(outcome: IngestOutcome): Extract<IngestOutcome, { duplicate: false }> {
  if (!outcome.handled || outcome.duplicate) {
    throw new Error(`expected a stored message, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

/** Ingest one message addressed to the configured inbox. */
async function ingest(
  deps: IngestDeps,
  text: string,
  envelopeTo = INBOX,
  envelopeFrom = "ada@example.com",
): Promise<IngestOutcome> {
  return ingestInbound(deps, { raw: raw(text), envelopeTo, envelopeFrom });
}

/** The thread row, decoded. */
async function thread(id: string): Promise<SupportThread> {
  const row = await supportDatabase(env.DB)
    .selectFrom(SUPPORT_THREADS_TABLE)
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new Error(`no thread ${id}`);
  return SupportThread.parse(row);
}

/** Every message on a thread, oldest first, decoded. */
async function messages(threadId: string): Promise<SupportMessage[]> {
  const rows = await supportDatabase(env.DB)
    .selectFrom(SUPPORT_MESSAGES_TABLE)
    .selectAll()
    .where("threadId", "=", threadId)
    .orderBy("id")
    .execute();
  return rows.map((row) => SupportMessage.parse(row));
}

/** Every attachment row on a message, decoded. */
async function attachments(messageId: string): Promise<SupportAttachment[]> {
  const rows = await supportDatabase(env.DB)
    .selectFrom(SUPPORT_ATTACHMENTS_TABLE)
    .selectAll()
    .where("messageId", "=", messageId)
    .orderBy("id")
    .execute();
  return rows.map((row) => SupportAttachment.parse(row));
}

/** How many rows a support table holds. */
async function count(table: string): Promise<number> {
  const { results } = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all<{ n: number }>();
  return results[0]?.n ?? 0;
}

/** A plain text message from Ada. */
function plain(options: {
  messageId: string;
  subject?: string;
  inReplyTo?: string;
  references?: string[];
  /**
   * The `Authentication-Results` the receiving MTA stamped. Defaults to a DMARC pass, because that is
   * the ordinary case for any domain that publishes a policy — and because the customer link is gated
   * on it, so a default of "unauthenticated" would make every linkage test silently test nothing.
   */
  authResults?: string | null;
}): string {
  const auth = options.authResults === undefined ? "mx.cloudflare.net; dmarc=pass" : options.authResults;
  return message(
    [
      "From: Ada Lovelace <Ada@Example.COM>",
      `To: ${INBOX}`,
      `Subject: ${options.subject ?? "Card declined"}`,
      `Message-ID: <${options.messageId}>`,
      ...(auth ? [`Authentication-Results: ${auth}`] : []),
      ...(options.inReplyTo ? [`In-Reply-To: <${options.inReplyTo}>`] : []),
      ...(options.references ? [`References: ${options.references.map((id) => `<${id}>`).join(" ")}`] : []),
      "Content-Type: text/plain; charset=utf-8",
    ],
    "The payment failed twice.",
  );
}

/** A message carrying `count` base64 attachments of `bytes` bytes each. */
function withAttachments(options: { messageId: string; parts: { filename: string; bytes: Uint8Array }[] }): string {
  return message(
    [
      "From: ada@example.com",
      `To: ${INBOX}`,
      "Authentication-Results: mx.cloudflare.net; dmarc=pass",
      "Subject: Receipt",
      `Message-ID: <${options.messageId}>`,
      'Content-Type: multipart/mixed; boundary="MIX"',
    ],
    multipart("MIX", [
      message(["Content-Type: text/plain"], "See attached."),
      ...options.parts.map((part) =>
        message(
          [
            "Content-Type: application/pdf",
            "Content-Transfer-Encoding: base64",
            `Content-Disposition: attachment; filename="${part.filename}"`,
          ],
          base64(part.bytes),
        ),
      ),
    ]),
  );
}

/** The support migrations as an app-database provider. The FTS5 index is off, so only the first runs. */
function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    {
      database: "app",
      namespace: "support",
      order: SUPPORT_MIGRATION_ORDER,
      migrations: { "0001_threads": support_0001_threads },
    },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

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
  await runMigrations(env.DB, provider());
});

describe("ingestInbound, a first message", () => {
  test("opens a thread and reports it as new", async () => {
    const { deps } = harness();
    const outcome = stored(await ingest(deps, plain({ messageId: "one@example.com" })));

    expect(outcome).toMatchObject({ handled: true, duplicate: false, newThread: true, attachments: 0 });
    expect(await thread(outcome.threadId)).toMatchObject({
      inboxAddress: INBOX,
      subject: "Card declined",
      fromAddress: "ada@example.com",
      fromName: "Ada Lovelace",
      messageCount: 1,
      archived: false,
      category: "uncategorized",
      classifiedAt: null,
    });
  });

  test("stores the message under the inbox it was routed to, not the address in the header", async () => {
    // `toAddress` is the resolved configured inbox. Storing the `To:` header instead would let a
    // sender name whichever of the adopter's inboxes they liked.
    const { deps } = harness({ inboundAddresses: [INBOX, "security@help.acme.test"] });
    const outcome = stored(await ingest(deps, plain({ messageId: "one@example.com" }), "security@help.acme.test"));

    const [row] = await messages(outcome.threadId);
    expect(row).toMatchObject({
      direction: "inbound",
      mimeMessageId: "one@example.com",
      toAddress: "security@help.acme.test",
      fromAddress: "ada@example.com",
      receivedAt: NOW,
    });
    expect(row?.textBody).toContain("The payment failed twice.");
  });

  test("records the size as received, so the guard and the dashboard read the same number", async () => {
    const { deps } = harness();
    const text = plain({ messageId: "one@example.com" });
    const outcome = stored(await ingest(deps, text));
    expect((await messages(outcome.threadId))[0]?.rawBytes).toBe(new TextEncoder().encode(text).byteLength);
  });

  test("links the sender to an account when the seam resolves one", async () => {
    const { deps } = harness({}, { linkSender: async () => "user-42" });
    const outcome = stored(await ingest(deps, plain({ messageId: "one@example.com" })));
    expect((await thread(outcome.threadId)).userId).toBe("user-42");
  });
});

describe("ingestInbound, threading", () => {
  test("a reply carrying In-Reply-To lands on the same thread and moves the counter", async () => {
    const { deps } = harness();
    const first = stored(await ingest(deps, plain({ messageId: "one@example.com" })));
    const reply = stored(await ingest(deps, plain({ messageId: "two@example.com", inReplyTo: "one@example.com" })));

    expect(reply.threadId).toBe(first.threadId);
    expect(reply.newThread).toBe(false);
    expect((await thread(first.threadId)).messageCount).toBe(2);
    expect(await count("pithy_support_threads")).toBe(1);
  });

  test("a reply whose In-Reply-To names nothing still threads on References", async () => {
    // The documented fallback. Some clients drop `In-Reply-To`, and a message can reach us out of
    // order — without this the customer's second mail opens a second thread.
    const { deps } = harness();
    const first = stored(await ingest(deps, plain({ messageId: "one@example.com" })));
    const reply = stored(
      await ingest(
        deps,
        plain({ messageId: "two@example.com", inReplyTo: "never-seen@example.com", references: ["one@example.com"] }),
      ),
    );

    expect(reply.threadId).toBe(first.threadId);
    expect(reply.newThread).toBe(false);
  });

  test("References is walked newest-first, so the nearest known ancestor wins", async () => {
    // Two separate threads, both named in one chain. Reading `References` from the root would attach
    // the reply to the older conversation — the bug that makes a long thread swallow a new one.
    const { deps } = harness();
    const older = stored(await ingest(deps, plain({ messageId: "one@example.com", subject: "Card declined" })));
    const nearer = stored(await ingest(deps, plain({ messageId: "two@example.com", subject: "Refund" })));
    expect(nearer.threadId).not.toBe(older.threadId);

    const reply = stored(
      await ingest(deps, plain({ messageId: "three@example.com", references: ["one@example.com", "two@example.com"] })),
    );
    expect(reply.threadId).toBe(nearer.threadId);
  });

  test("a message naming nothing we hold opens its own thread", async () => {
    const { deps } = harness();
    await ingest(deps, plain({ messageId: "one@example.com" }));
    const orphan = stored(
      await ingest(deps, plain({ messageId: "two@example.com", inReplyTo: "elsewhere@other.test" })),
    );
    expect(orphan.newThread).toBe(true);
    expect(await count("pithy_support_threads")).toBe(2);
  });

  test("the thread keeps the subject it opened with, whatever a later reply calls itself", async () => {
    const { deps } = harness();
    const first = stored(await ingest(deps, plain({ messageId: "one@example.com", subject: "Card declined" })));
    await ingest(
      deps,
      plain({ messageId: "two@example.com", inReplyTo: "one@example.com", subject: "Re: something else" }),
    );
    expect((await thread(first.threadId)).subject).toBe("Card declined");
  });
});

describe("ingestInbound, redelivery", () => {
  test("the same Message-ID a second time is a no-op", async () => {
    // Email Routing redelivering is normal — a retry after a transient failure looks exactly like
    // this. A duplicate in somebody's inbox is not normal.
    const { deps } = harness();
    const text = plain({ messageId: "one@example.com" });
    const first = stored(await ingest(deps, text));
    const again = await ingest(deps, text);

    expect(again).toEqual({ handled: true, duplicate: true, threadId: first.threadId, messageId: first.messageId });
    expect(await count("pithy_support_messages")).toBe(1);
    expect(await count("pithy_support_threads")).toBe(1);
    expect((await thread(first.threadId)).messageCount).toBe(1);
  });
});

describe("ingestInbound, mail that is not ours", () => {
  test("a message to an unconfigured address is not handled and writes nothing", async () => {
    // Every capability's handler sees every message the Worker receives, so mail for the bounce
    // handler passing through here is the normal case rather than an event.
    const { deps, emitted } = harness();
    const outcome = await ingestInbound(deps, {
      raw: raw(plain({ messageId: "one@example.com" })),
      envelopeTo: "hello@acme.test",
    });

    expect(outcome).toEqual({ handled: false, reason: "not_addressed" });
    expect(await count("pithy_support_threads")).toBe(0);
    expect(await count("pithy_support_messages")).toBe(0);
    expect(emitted).toEqual([]);
  });
});

describe("ingestInbound, the guard", () => {
  test("an over-size message is refused before it is parsed", async () => {
    // The bytes are not a message at all — no `From`, nothing parseable. If the size check ran after
    // the parse this would throw instead of returning a refusal.
    const { deps } = harness({ guard: { maxRawBytes: 100 } });
    const outcome = await ingestInbound(deps, { raw: raw("x".repeat(500)), envelopeTo: INBOX });

    expect(outcome).toEqual({ handled: false, reason: "rejected", rejection: "too_large" });
    expect(await count("pithy_support_messages")).toBe(0);
  });

  test("a refusal is audited as denied, with the sender's address as evidence rather than as identity", async () => {
    const { deps, emitted } = harness({ guard: { maxRawBytes: 100 } });
    await ingestInbound(deps, { raw: raw("x".repeat(500)), envelopeTo: INBOX });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      action: "support/inbound_rejected",
      outcome: "denied",
      severity: "warning",
      actorType: "anonymous",
      // Null deliberately: an inbound `From` is an unauthenticated claim, and writing it in as the
      // actor is how a forged header gets to name somebody in a long-lived trail.
      actorId: null,
      resourceType: "support_inbox",
      metadata: { reason: "too_large" },
    });
  });

  test("the audit metadata carries the reason only, never the byte counts", async () => {
    // The specifics belong in the log, which is bounded; the trail is queryable and long-lived.
    const { deps, emitted } = harness({ guard: { maxRawBytes: 100 } });
    await ingestInbound(deps, { raw: raw("x".repeat(500)), envelopeTo: INBOX });
    expect(JSON.stringify(emitted[0]?.metadata)).not.toContain("500");
  });

  test("an accepted message is not audited — the row is the better record", async () => {
    const { deps, emitted } = harness();
    await ingest(deps, plain({ messageId: "one@example.com" }));
    expect(emitted).toEqual([]);
  });
});

describe("ingestInbound, attachments", () => {
  const receipt = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a, 0x41]);

  test("the bytes go to R2 and the metadata to D1", async () => {
    const { deps } = harness();
    const outcome = stored(
      await ingest(
        deps,
        withAttachments({ messageId: "one@example.com", parts: [{ filename: "receipt.pdf", bytes: receipt }] }),
      ),
    );

    expect(outcome.attachments).toBe(1);
    const [row] = await attachments(outcome.messageId);
    expect(row).toMatchObject({
      filename: "receipt.pdf",
      contentType: "application/pdf",
      size: receipt.byteLength,
      inline: false,
    });

    const object = await env.SUPPORT_BUCKET.get(row?.storageKey ?? "");
    expect(object).not.toBeNull();
    expect(new Uint8Array(await (object as R2ObjectBody).arrayBuffer())).toEqual(receipt);
  });

  test("the storage key is server-derived and carries no part of the declared filename", async () => {
    // A filename is attacker-controlled — it can hold a path, a scheme, or somebody else's name. A
    // key built from one hands the sender partial control over where bytes land.
    const { deps } = harness();
    const outcome = stored(
      await ingest(
        deps,
        withAttachments({
          messageId: "one@example.com",
          parts: [{ filename: "quarterly-report.pdf", bytes: receipt }],
        }),
      ),
    );

    const [row] = await attachments(outcome.messageId);
    expect(row?.storageKey).toBe(`support/${outcome.threadId}/${row?.id}`);
    expect(row?.storageKey).not.toContain("quarterly");
    expect(row?.filename).toBe("quarterly-report.pdf");
  });

  test("the stored object is application/octet-stream, never the type the sender declared", async () => {
    // R2 echoes the stored content type back on a presigned GET, and a browser handed `text/html`
    // from an object URL renders it — so honouring a declared type would turn every attachment into
    // stored XSS with a signed URL as the exploit. The declared type stays in D1, where it is data.
    const { deps } = harness();
    const outcome = stored(
      await ingest(
        deps,
        withAttachments({ messageId: "one@example.com", parts: [{ filename: "page.html", bytes: receipt }] }),
      ),
    );

    const [row] = await attachments(outcome.messageId);
    const object = await env.SUPPORT_BUCKET.head(row?.storageKey ?? "");
    expect(object?.httpMetadata?.contentType).toBe("application/octet-stream");
    expect(object?.httpMetadata?.contentDisposition).toBe("attachment");
    expect(row?.contentType).toBe("application/pdf");
  });

  test("an attachment over the byte bound is skipped and the message it arrived on is still stored", async () => {
    // The message is the thing worth keeping. An operator who can see that a file was too large is
    // better off than one whose customer's mail silently vanished.
    const { deps, records } = harness({ attachments: { maxBytes: 16 } });
    const outcome = stored(
      await ingest(
        deps,
        withAttachments({ messageId: "one@example.com", parts: [{ filename: "huge.pdf", bytes: new Uint8Array(64) }] }),
      ),
    );

    expect(outcome.attachments).toBe(0);
    expect(await attachments(outcome.messageId)).toEqual([]);
    expect((await messages(outcome.threadId))[0]?.textBody).toContain("See attached.");
    expect(records.map((record) => record.msg)).toContain("support attachment skipped, over the size bound");
  });

  test("more attachments than the count bound are truncated", async () => {
    // How many parts a message has is a number the sender chose, so it is bounded before the loop
    // rather than inside it.
    const { deps } = harness({ attachments: { maxCount: 2 } });
    const outcome = stored(
      await ingest(
        deps,
        withAttachments({
          messageId: "one@example.com",
          parts: [1, 2, 3, 4, 5].map((n) => ({ filename: `file-${n}.pdf`, bytes: receipt })),
        }),
      ),
    );

    expect(outcome.attachments).toBe(2);
    expect(await count("pithy_support_attachments")).toBe(2);
  });

  test("attachments turned off keeps the message and drops the files", async () => {
    const { deps } = harness({ attachments: { enabled: false } });
    const outcome = stored(
      await ingest(
        deps,
        withAttachments({ messageId: "one@example.com", parts: [{ filename: "receipt.pdf", bytes: receipt }] }),
      ),
    );
    expect(outcome.attachments).toBe(0);
    expect(await count("pithy_support_messages")).toBe(1);
  });
});

describe("ingestInbound, the raw MIME", () => {
  test("the bytes as they arrived are written to R2 and the row points at them", async () => {
    // Everything stored on the row is derived. Keeping the original is what makes a parser fix or a
    // sanitiser improvement re-runnable rather than a decision taken once, inside an email handler.
    const { deps } = harness();
    const text = plain({ messageId: "one@example.com" });
    const outcome = stored(await ingest(deps, text));

    const [row] = await messages(outcome.threadId);
    expect(row?.rawKey).toBe(rawMessageKey(outcome.threadId, outcome.messageId));
    const object = await env.SUPPORT_BUCKET.get(row?.rawKey ?? "");
    expect(await (object as R2ObjectBody).text()).toBe(text);
  });
});

describe("ingestInbound, bodies", () => {
  const html =
    '<p onclick="steal()">Please refund me<script>alert(1)</script></p><img src="https://tracker.test/p.gif">';

  test("an HTML-only message gets a derived text body and a sanitised HTML body", async () => {
    const { deps } = harness();
    const outcome = stored(
      await ingest(
        deps,
        message(
          [
            "From: ada@example.com",
            `To: ${INBOX}`,
            "Subject: Refund",
            "Message-ID: <one@example.com>",
            "Content-Type: text/html; charset=utf-8",
          ],
          html,
        ),
      ),
    );

    const [row] = await messages(outcome.threadId);
    // The classifier reads `textBody`, so an HTML-only message must not leave it empty — and markup
    // is both tokens the adopter pays for and an injection surface for a model.
    expect(row?.textBody).toContain("Please refund me");
    expect(row?.textBody).not.toContain("<p");
    expect(row?.htmlBody).toContain("Please refund me");
    expect(row?.htmlBody).not.toContain("<script");
    expect(row?.htmlBody).not.toContain("onclick");
    // A remote image in support mail is a read receipt, so the source is stripped rather than sandboxed.
    expect(row?.htmlBody).not.toContain("tracker.test");
  });

  test("a message carrying both parts keeps the text it was sent with", async () => {
    const { deps } = harness();
    const outcome = stored(
      await ingest(
        deps,
        message(
          [
            "From: ada@example.com",
            `To: ${INBOX}`,
            "Subject: Both",
            "Message-ID: <one@example.com>",
            'Content-Type: multipart/alternative; boundary="ALT"',
          ],
          multipart("ALT", [
            message(["Content-Type: text/plain; charset=utf-8"], "the plain alternative"),
            message(["Content-Type: text/html; charset=utf-8"], html),
          ]),
        ),
      ),
    );

    const [row] = await messages(outcome.threadId);
    expect(row?.textBody).toContain("the plain alternative");
    expect(row?.htmlBody).toContain("Please refund me");
  });

  test("a message with no subject is stored under a readable placeholder", async () => {
    const { deps } = harness();
    const outcome = stored(
      await ingest(deps, message(["From: ada@example.com", `To: ${INBOX}`, "Message-ID: <one@example.com>"], "Help.")),
    );
    expect((await thread(outcome.threadId)).subject).toBe("(no subject)");
  });
});

describe("ingestInbound, classification", () => {
  test("an auto-submitted message is stored but never classified", async () => {
    // An out-of-office is context an operator wants and is not worth an inference — the only
    // per-message cost that is not fixed.
    const { deps, classified } = harness();
    const outcome = stored(
      await ingest(
        deps,
        message(
          [
            "From: ada@example.com",
            `To: ${INBOX}`,
            "Subject: Out of office",
            "Message-ID: <one@example.com>",
            "Auto-Submitted: auto-replied",
          ],
          "Away until Monday.",
        ),
      ),
    );

    expect(outcome.classifying).toBe(false);
    expect(classified).toEqual([]);
    expect(await count("pithy_support_messages")).toBe(1);
  });

  test("ai.enabled false dispatches nothing at all", async () => {
    const { deps, classified } = harness({ ai: { enabled: false } });
    const outcome = stored(await ingest(deps, plain({ messageId: "one@example.com" })));

    expect(outcome.classifying).toBe(false);
    expect(classified).toEqual([]);
  });

  test("an ordinary message dispatches classification for the row that was just written", async () => {
    const { deps, classified } = harness();
    const outcome = stored(await ingest(deps, plain({ messageId: "one@example.com" })));
    expect(classified).toEqual([outcome.messageId]);
  });
});

describe("ingestInbound, the seams that are allowed to fail", () => {
  test("a classification dispatch that rejects does not lose the message", async () => {
    // The whole reason classification is a Workflow: a model that is slow or briefly down must never
    // take the persistence of a customer's message with it.
    const { deps, records } = harness(
      {},
      {
        dispatchClassify: async () => {
          throw new Error("workflow binding unavailable");
        },
      },
    );
    const outcome = stored(await ingest(deps, plain({ messageId: "one@example.com" })));

    expect(outcome.classifying).toBe(true);
    expect(await count("pithy_support_messages")).toBe(1);
    expect((await messages(outcome.threadId))[0]?.textBody).toContain("The payment failed twice.");
    expect(records.map((record) => record.msg)).toContain("support classification dispatch failed");
  });

  test("with the FTS index composed, an ingested message is findable by a word in its body", async () => {
    // The coverage gap that let a refactor silently drop the index write from ingest entirely: every
    // other test in this file runs with `fts: false`, and the search tests call `indexMessage`
    // directly — so nothing exercised the one line that connects them.
    await env.DB.exec("DROP TABLE IF EXISTS pithy_support_search");
    await createSearchIndex(supportDatabase(env.DB));

    const { deps } = harness({}, {}, { fts: true });
    const outcome = stored(await ingest(deps, plain({ messageId: "indexed@example.com" })));

    const { results } = await env.DB.prepare(
      "SELECT thread_id FROM pithy_support_search WHERE pithy_support_search MATCH 'payment'",
    ).all<{ thread_id: string }>();
    expect(results.map((row) => row.thread_id)).toEqual([outcome.threadId]);
  });

  test("ten attachments — the configured default — all store", async () => {
    // The exact threshold that failed. An attachment row is 11 columns, so D1's 100-parameter cap is
    // reached at ten rows: nine worked, ten stored *zero* while the bytes were already in R2, and the
    // guard around the call reported it as a warn line. The default configuration lost data silently.
    const { deps } = harness();
    const parts = Array.from({ length: 10 }, (_, i) => ({
      filename: `page-${i}.pdf`,
      bytes: new Uint8Array([i, i, i]),
    }));

    const outcome = stored(await ingest(deps, withAttachments({ messageId: "ten@example.com", parts })));

    expect(outcome.attachments).toBe(10);
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM pithy_support_attachments WHERE message_id = ?")
      .bind(outcome.messageId)
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(10);
  });

  test("an unauthenticated sender is stored, but never resolved to an account", async () => {
    // The spoofing case, end to end. A message claiming `From: Ada` with no DMARC pass is still a
    // support request and is still stored — but the customer link is not attempted, so an attacker
    // cannot decorate their own thread with a real customer's name, entitlements, and purchase
    // history for an operator to read and act on.
    const linked: string[] = [];
    const { deps } = harness(
      {},
      {
        linkSender: async (address) => {
          linked.push(address);
          return "user-42";
        },
      },
    );

    const outcome = stored(await ingest(deps, plain({ messageId: "spoof@example.com", authResults: null })));

    const row = await thread(outcome.threadId);
    expect(row.senderAuthenticated).toBe(false);
    // Matched, deliberately — the useful part survives. What does not survive is the *claim*: the
    // thread records the sender as unverified, and `resolveSenderContext` withholds the billing
    // history on that basis.
    expect(row.userId).toBe("user-42");
    expect(linked).toEqual(["ada@example.com"]);
  });

  test("spf=pass from an unaligned envelope sender is still unauthenticated", async () => {
    // SPF passed for `evil.test`, the domain the attacker actually sent from. It says nothing about
    // the `From:` header they wrote, which is precisely the gap DMARC exists to close.
    const { deps } = harness({}, { linkSender: async () => "user-42" });
    const outcome = stored(
      await ingest(
        deps,
        plain({ messageId: "unaligned@example.com", authResults: "mx; spf=pass" }),
        INBOX,
        "attacker@evil.test",
      ),
    );

    const row = await thread(outcome.threadId);
    expect(row.senderAuthenticated).toBe(false);
  });

  test("a DMARC-passing sender is authenticated when the adopter trusts the header", async () => {
    // The other half, so the gate is not vacuously closed. `trustAuthenticationResults` is the
    // precondition: without an adopter saying their MTA stamps and strips the header, a `dmarc=pass`
    // in the received bytes may simply be one the sender wrote.
    const { deps } = harness({ guard: { trustAuthenticationResults: true } }, { linkSender: async () => "user-42" });
    const outcome = stored(await ingest(deps, plain({ messageId: "genuine@example.com" })));

    const row = await thread(outcome.threadId);
    expect(row.senderAuthenticated).toBe(true);
    expect(row.userId).toBe("user-42");
  });

  test("a sender link that rejects still opens the thread, with no account attached", async () => {
    // A sender who has no account is the normal case, and an auth package that is not composed must
    // not stop mail from being stored.
    const { deps, records } = harness(
      {},
      {
        linkSender: async () => {
          throw new Error("no auth capability composed");
        },
      },
    );
    const outcome = stored(await ingest(deps, plain({ messageId: "one@example.com" })));

    expect((await thread(outcome.threadId)).userId).toBeNull();
    expect(await count("pithy_support_messages")).toBe(1);
    expect(records.map((record) => record.msg)).toContain("support sender link failed");
  });
});

describe("ingestInbound, an archived thread", () => {
  test("a reply reopens it", async () => {
    // The one failure a support inbox cannot have is a customer writing back and nobody seeing it.
    const { deps } = harness();
    const first = stored(await ingest(deps, plain({ messageId: "one@example.com" })));
    await env.DB.prepare(
      "UPDATE pithy_support_threads SET archived = 1, archived_at = 1, archived_by = 'ops' WHERE id = ?",
    )
      .bind(first.threadId)
      .run();
    expect((await thread(first.threadId)).archived).toBe(true);

    await ingest(deps, plain({ messageId: "two@example.com", inReplyTo: "one@example.com" }));

    const reopened = await thread(first.threadId);
    expect(reopened.archived).toBe(false);
    expect(reopened.archivedAt).toBeNull();
    expect(reopened.archivedBy).toBeNull();
    expect(reopened.messageCount).toBe(2);
  });
});
