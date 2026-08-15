// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { SUPPORT_MIGRATION_ORDER } from "../capability";
import { SupportConfig } from "../config/config";
import { resolveCategories } from "../data/categories";
import { SupportMessage } from "../data/message";
import {
  SUPPORT_ATTACHMENTS_TABLE,
  SUPPORT_MESSAGES_TABLE,
  SUPPORT_THREADS_TABLE,
  supportDatabase,
} from "../data/tables";
import { SupportThread } from "../data/thread";
import { checkRates } from "../inbound/guard";
import { support_0001_threads } from "../migrations/0001_threads";
import { safeFilename } from "../mime/parse";
import { type SubmitDeps, submissionMessageId, submitFeedback } from "./submit";

/**
 * The in-app submission path against real D1.
 *
 * A Workers test because every claim worth making here is one only SQLite can settle: that one account
 * cannot flood the inbox over a sliding window, that a thread belonging to somebody else is
 * indistinguishable from one that does not exist, and that the two channels' rate bounds genuinely do
 * not see each other.
 */

const INBOX = "support@help.example.com";
const ADA = "user-ada";
const GRACE = "user-grace";
const T0 = 1_700_000_000_000;

const db = supportDatabase(env.DB);

const provider: MigrationProvider = (() => {
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
})();

/** Ids, in order, so a test asserts on a sequence rather than on a generated string. */
let counter = 0;
const nextId = (): string => {
  counter += 1;
  return `gen-${String(counter).padStart(4, "0")}`;
};

let emitted: AuditEventInput[] = [];
let classified: string[] = [];
let clock = T0;

/** The deps under test, with every seam a fake and the clock injected. */
function deps(overrides: Partial<SubmitDeps> = {}): SubmitDeps {
  return {
    db,
    config: SupportConfig.parse({ inboundAddresses: [INBOX] }),
    // The effective taxonomy the capability would hand over: the eight Pithy ships, plus one an adopter
    // declared, so a test can tell "the kit knows this key" from "this project knows this key".
    categories: resolveCategories({
      tournament_dispute: "The sender is contesting a tournament result, a disqualification, or a prize.",
    }),
    fts: false,
    resolveAccount: async (userId) =>
      userId === ADA ? { email: "ada@example.com", name: "Ada Lovelace" } : { email: "grace@example.com" },
    dispatchClassify: async (messageId) => {
      classified.push(messageId);
      return true;
    },
    emit: async (event) => {
      emitted.push(event);
    },
    log: noopLogger,
    newId: nextId,
    now: () => new Date(clock),
    ...overrides,
  };
}

/**
 * File one submission with sensible defaults.
 *
 * **`return await`, not `return`, and it is not redundant here.** The declared-category refusal is the
 * one check in `submitFeedback` that fires before its first `await`, so the promise is already rejected
 * the moment it is created. Returning it bare makes this wrapper's promise *adopt* it a microtask
 * later, and workerd reports the gap as an unhandled rejection — four of them, in a suite that
 * otherwise passes. Awaiting attaches the handler in the same turn. The production caller
 * (`submitFeedbackRequest`) already awaits, so this closes a hole in the harness and not in the code.
 */
async function submit(overrides: Partial<Parameters<typeof submitFeedback>[1]> = {}, depsOverrides = {}) {
  return await submitFeedback(deps(depsOverrides), {
    userId: ADA,
    subject: "Export button does nothing",
    body: "I press Export and nothing happens.",
    attachments: [],
    ...overrides,
  });
}

/** The code on a thrown `PithyError`, or the error itself when it is something else. */
async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof PithyError) return error.payload.code;
    throw error;
  }
  throw new Error("expected a PithyError, but nothing was thrown");
}

beforeEach(async () => {
  for (const table of [
    "pithy_support_attachments",
    "pithy_support_messages",
    "pithy_support_threads",
    "pithy_migrations",
  ]) {
    await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  await env.DB.prepare("DROP TABLE IF EXISTS pithy_support_classifications").run();
  await env.DB.prepare("DROP TABLE IF EXISTS pithy_support_thread_flags").run();
  await runMigrations(env.DB, provider);
  emitted = [];
  classified = [];
  clock = T0;
  counter = 0;
});

describe("opening a thread from inside the app", () => {
  test("a signed-in user opens a support thread with no email involved", async () => {
    const outcome = await submit();
    expect(outcome.newThread).toBe(true);

    const thread = SupportThread.parse(
      await db
        .selectFrom(SUPPORT_THREADS_TABLE)
        .selectAll()
        .where("id", "=", outcome.threadId)
        .executeTakeFirstOrThrow(),
    );
    expect(thread.channel).toBe("app");
    // The account arrives already established, and the row says which kind of established it is.
    expect(thread.userId).toBe(ADA);
    expect(thread.accountLinkSource).toBe("session");
    expect(thread.senderAuthenticated).toBe(true);
    // The address a reply leaves for, read from the account rather than from anything the client sent.
    expect(thread.fromAddress).toBe("ada@example.com");
  });

  test("the classifier runs over the same taxonomy, with nothing new introduced", async () => {
    const outcome = await submit();
    // The same dispatch the mail path uses, keyed on the stored message — so the thread lands in the
    // adopter's own categories with no submission-only vocabulary anywhere.
    expect(classified).toEqual([outcome.messageId]);
    const thread = SupportThread.parse(
      await db
        .selectFrom(SUPPORT_THREADS_TABLE)
        .selectAll()
        .where("id", "=", outcome.threadId)
        .executeTakeFirstOrThrow(),
    );
    expect(thread.category).toBe("uncategorized");
  });

  test("the declared context is carried, and an undeclared key never reaches the row", async () => {
    const outcome = await submit({
      context: { screen: "reports", appVersion: "2.4.1", platform: "web", environment: "prod", locale: "en-GB" },
    });
    const message = SupportMessage.parse(
      await db
        .selectFrom(SUPPORT_MESSAGES_TABLE)
        .selectAll()
        .where("id", "=", outcome.messageId)
        .executeTakeFirstOrThrow(),
    );
    expect(message.context).toEqual({
      screen: "reports",
      appVersion: "2.4.1",
      platform: "web",
      environment: "prod",
      locale: "en-GB",
    });
    expect(message.channel).toBe("app");
    expect(message.submittedByUserId).toBe(ADA);
  });

  test("a message id is minted, so an answer to a reply threads back instead of forking", async () => {
    const outcome = await submit();
    const message = SupportMessage.parse(
      await db
        .selectFrom(SUPPORT_MESSAGES_TABLE)
        .selectAll()
        .where("id", "=", outcome.messageId)
        .executeTakeFirstOrThrow(),
    );
    expect(message.mimeMessageId).toBe(`${outcome.messageId}@help.example.com`);
  });

  test("with no address configured the thread still opens, and carries no reply address", async () => {
    // A project collecting in-app feedback with no mail set up at all. Supported: the report is the
    // point, and answering it is a separate decision the adopter has not made yet.
    const outcome = await submit({}, { config: SupportConfig.parse({}) });
    const thread = SupportThread.parse(
      await db
        .selectFrom(SUPPORT_THREADS_TABLE)
        .selectAll()
        .where("id", "=", outcome.threadId)
        .executeTakeFirstOrThrow(),
    );
    expect(thread.inboxAddress).toBeNull();
    expect(submissionMessageId("m-1", null)).toBeNull();
  });

  test("an account that cannot be read is a fault, not a thread with a guessed address", async () => {
    const code = await codeOf(() => submit({}, { resolveAccount: async () => null }));
    expect(code).toBe("core/internal");
    expect(await db.selectFrom(SUPPORT_THREADS_TABLE).selectAll().execute()).toEqual([]);
  });
});

describe("what the submitter said it was about", () => {
  /** The thread a submission produced, decoded. */
  async function threadOf(threadId: string): Promise<SupportThread> {
    return SupportThread.parse(
      await db.selectFrom(SUPPORT_THREADS_TABLE).selectAll().where("id", "=", threadId).executeTakeFirstOrThrow(),
    );
  }

  test("a declared category lands on the thread beside the classifier's, not on top of it", async () => {
    const outcome = await submit({ declaredCategory: "billing" });
    const thread = await threadOf(outcome.threadId);

    // Two columns, two facts. `category` is still what a brand-new thread carries, because no model
    // has looked at this yet — and that is exactly the state a single conflated column cannot describe.
    expect(thread.declaredCategory).toBe("billing");
    expect(thread.category).toBe("uncategorized");
  });

  test("an adopter's own category is accepted, because the taxonomy is theirs and not the kit's", async () => {
    const outcome = await submit({ declaredCategory: "tournament_dispute" });
    expect((await threadOf(outcome.threadId)).declaredCategory).toBe("tournament_dispute");
  });

  test("saying nothing is a state of its own, and it is not `uncategorized`", async () => {
    // Mail always, and any client with no chooser. Null is what makes "nobody was asked" legible
    // against a submitter who deliberately picked the catch-all.
    const outcome = await submit();
    expect((await threadOf(outcome.threadId)).declaredCategory).toBeNull();

    const chosen = await submit({ declaredCategory: "uncategorized" });
    expect((await threadOf(chosen.threadId)).declaredCategory).toBe("uncategorized");
  });

  test("a category outside the taxonomy is refused, never stored and never downgraded", async () => {
    // Stored, it would make this column a client-writable vocabulary and every filter on it a long
    // tail of one-off keys. Downgraded to `uncategorized`, a broken chooser would be indistinguishable
    // from somebody who chose nothing — which is the collapse the column exists to prevent.
    expect(await codeOf(() => submit({ declaredCategory: "refund_dispute" }))).toBe("support/invalid_category");
    expect(await db.selectFrom(SUPPORT_THREADS_TABLE).selectAll().execute()).toEqual([]);
    expect(await db.selectFrom(SUPPORT_MESSAGES_TABLE).selectAll().execute()).toEqual([]);
  });

  test("the refusal names nothing the submitter wrote in the part a client can read", async () => {
    // This capability's whole input is text somebody else chose. An error echoing it back would turn
    // the error channel into a reflection surface; the value belongs in `detail`, which the HTTP codec
    // strips.
    try {
      await submit({ declaredCategory: "totally_made_up" });
      throw new Error("expected a refusal");
    } catch (error) {
      if (!(error instanceof PithyError)) throw error;
      expect(error.payload.message).not.toContain("totally_made_up");
      expect(error.payload.detail).toContain("totally_made_up");
    }
  });

  test("a category on a follow-up is refused rather than ignored or honoured", async () => {
    const first = await submit({ declaredCategory: "billing" });
    clock = T0 + 60_000;

    // Ignoring it is a chooser that does nothing, which is the whole defect this closes. Honouring it
    // would let a later message rewrite the premise the conversation was opened on, the way `subject`
    // deliberately cannot. So it is refused, and the claim the thread was filed under stands.
    expect(await codeOf(() => submit({ threadId: first.threadId, declaredCategory: "bug_report" }))).toBe(
      "validation/invalid_input",
    );
    expect((await threadOf(first.threadId)).declaredCategory).toBe("billing");
    expect((await threadOf(first.threadId)).messageCount).toBe(1);
  });

  test("a follow-up with no category leaves the claim exactly where it was", async () => {
    const first = await submit({ declaredCategory: "billing" });
    clock = T0 + 60_000;
    await submit({ threadId: first.threadId, body: "Still broken." });
    expect((await threadOf(first.threadId)).declaredCategory).toBe("billing");
  });

  test("the refusal is the cheapest one, so nothing is decoded or counted before it", async () => {
    // Order of operations, asserted rather than assumed: a bad category costs no query. The account
    // resolver is the first thing `submitFeedback` reaches for, so a resolver that throws proves the
    // refusal happened ahead of it.
    const code = await codeOf(() =>
      submit(
        { declaredCategory: "not_a_category" },
        {
          resolveAccount: async () => {
            throw new Error("the account was read before the category was checked");
          },
        },
      ),
    );
    expect(code).toBe("support/invalid_category");
  });
});

describe("continuing a thread", () => {
  test("a follow-up appends to the caller's own thread rather than opening another", async () => {
    const first = await submit();
    clock = T0 + 60_000;
    const second = await submit({ threadId: first.threadId, body: "Still broken." });

    expect(second.newThread).toBe(false);
    expect(second.threadId).toBe(first.threadId);
    const thread = SupportThread.parse(
      await db.selectFrom(SUPPORT_THREADS_TABLE).selectAll().where("id", "=", first.threadId).executeTakeFirstOrThrow(),
    );
    expect(thread.messageCount).toBe(2);
    expect(thread.lastMessageAt.getTime()).toBe(T0 + 60_000);
  });

  test("writing again reopens a thread support had marked done", async () => {
    const first = await submit();
    await db
      .updateTable(SUPPORT_THREADS_TABLE)
      .set({ archived: 1, archivedAt: T0, archivedBy: "ops" })
      .where("id", "=", first.threadId)
      .execute();

    await submit({ threadId: first.threadId, body: "This happened again." });
    const thread = SupportThread.parse(
      await db.selectFrom(SUPPORT_THREADS_TABLE).selectAll().where("id", "=", first.threadId).executeTakeFirstOrThrow(),
    );
    // Somebody wrote back and nobody saw it is the one failure a support inbox cannot have.
    expect(thread.archived).toBe(false);
    expect(thread.archivedBy).toBeNull();
  });

  test("somebody else's thread answers 404, the same as one that does not exist", async () => {
    const mine = await submit();
    // A 403 would confirm the id names a real conversation, and on an inbox of other people's
    // correspondence that confirmation is itself the disclosure.
    expect(await codeOf(() => submit({ userId: GRACE, threadId: mine.threadId }))).toBe("support/not_found");
    expect(await codeOf(() => submit({ userId: GRACE, threadId: "no-such-thread" }))).toBe("support/not_found");
  });

  test("an email thread linked to the caller's account is not theirs to continue", async () => {
    // The link on a mail thread was matched against an address in a header nobody proved. Treating it
    // as ownership would turn the mail path's known weakness into a write primitive.
    await db
      .insertInto(SUPPORT_THREADS_TABLE)
      .values(
        SupportThread.encode({
          id: "mail-thread",
          channel: "email",
          inboxAddress: INBOX,
          subject: "Sent by post",
          fromAddress: "ada@example.com",
          fromName: null,
          senderAuthenticated: false,
          userId: ADA,
          accountLinkSource: "email_address",
          category: "uncategorized",
          priority: "normal",
          sentiment: "neutral",
          confidence: null,
          model: null,
          classifiedAt: null,
          archived: false,
          archivedAt: null,
          archivedBy: null,
          messageCount: 1,
          firstMessageAt: new Date(T0),
          lastMessageAt: new Date(T0),
          createdAt: new Date(T0),
          updatedAt: new Date(T0),
        }),
      )
      .execute();

    expect(await codeOf(() => submit({ threadId: "mail-thread" }))).toBe("support/not_found");
  });
});

describe("the per-account bound", () => {
  test("one account cannot flood the inbox", async () => {
    const limit = SupportConfig.parse({}).submission.maxPerAccountPerHour;
    for (let index = 0; index < limit; index += 1) {
      clock = T0 + index;
      await submit({ body: `report ${index}` });
    }

    clock = T0 + limit;
    expect(await codeOf(() => submit({ body: "one too many" }))).toBe("support/rejected");

    // Refused before anything was written: the eleventh report leaves no row anywhere.
    const messages = await db.selectFrom(SUPPORT_MESSAGES_TABLE).selectAll().execute();
    expect(messages).toHaveLength(limit);
  });

  test("the refusal is audited, and names the account rather than a claim", async () => {
    const limit = 1;
    const config = SupportConfig.parse({ inboundAddresses: [INBOX], submission: { maxPerAccountPerHour: limit } });
    await submit({}, { config });
    clock = T0 + 1;
    await codeOf(() => submit({}, { config }));

    // A refused submission leaves no row, so without this event a flood is invisible in exactly the
    // situation an adopter most needs to see it. `actorId` is populated — the opposite of the mail
    // path, where the sender is an unproven header.
    const refusals = emitted.filter((event) => event.action === "support/submission_rejected");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.outcome).toBe("denied");
    expect(refusals[0]?.actorType).toBe("user");
    expect(refusals[0]?.actorId).toBe(ADA);
  });

  test("the window slides — an hour later the account may write again", async () => {
    const config = SupportConfig.parse({ inboundAddresses: [INBOX], submission: { maxPerAccountPerHour: 1 } });
    await submit({}, { config });
    clock = T0 + 60 * 60 * 1000 + 1;
    await expect(submit({}, { config })).resolves.toMatchObject({ newThread: true });
  });

  test("the bound is per account, so one user's volume never blocks another", async () => {
    const config = SupportConfig.parse({ inboundAddresses: [INBOX], submission: { maxPerAccountPerHour: 1 } });
    await submit({}, { config });
    clock = T0 + 1;
    await expect(submit({ userId: GRACE }, { config })).resolves.toMatchObject({ newThread: true });
  });

  test("neither channel's bound can starve the other", async () => {
    // App submissions must not consume the mail inbox's capacity, and mail must not stop the app's own
    // users reporting the outage. Both counts filter on `channel`, so a run of submissions leaves the
    // mail guard reading zero.
    const config = SupportConfig.parse({
      inboundAddresses: [INBOX],
      guard: { maxPerHour: 2, maxPerSenderPerHour: 2 },
      submission: { maxPerAccountPerHour: 5 },
    });
    for (let index = 0; index < 5; index += 1) {
      clock = T0 + index;
      await submit({ body: `report ${index}` }, { config });
    }

    const verdict = await checkRates(db, config.guard, {
      rawBytes: 100,
      fromAddress: "ada@example.com",
      now: new Date(clock),
    });
    expect(verdict).toEqual({ accepted: true });
  });
});

describe("attachments on a submission", () => {
  const png = { filename: "shot.png", contentType: "image/png", bytes: new Uint8Array([1, 2, 3, 4]) };

  /**
   * A filename carrying both tricks the sanitiser exists for: path separators, and a right-to-left
   * override that renders the rest backwards so `.exe` reads as `.png`.
   *
   * **Built from an escape rather than written literally.** A raw U+202E is invisible in a diff — it
   * reorders the source around it — so `sourceFiles.test.ts` refuses one anywhere this repository
   * commits. A test for the bidi defence that smuggled a bidi character into the codebase would be
   * the joke writing itself.
   */
  const HOSTILE_FILENAME = "../../etc/shot\u202Egnp.exe";

  test("an allowed file is stored, and the row never names what the client called the object", async () => {
    const outcome = await submit({ attachments: [png] }, { bucket: env.SUPPORT_BUCKET });
    expect(outcome.attachments).toBe(1);

    const rows = await db.selectFrom(SUPPORT_ATTACHMENTS_TABLE).selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.filename).toBe("shot.png");
    // Server-derived, so a client can never name an object or guess the one beside it.
    expect(rows[0]?.storageKey).toBe(`support/${outcome.threadId}/${rows[0]?.id}`);
  });

  test("the bytes are stored as octet-stream whatever the client declared", async () => {
    // R2 echoes the stored type back on a presigned GET, and a browser renders `text/html`. Honouring
    // a declared type would make every attachment a stored-XSS delivery mechanism.
    await submit({ attachments: [png] }, { bucket: env.SUPPORT_BUCKET });
    const row = await db.selectFrom(SUPPORT_ATTACHMENTS_TABLE).selectAll().executeTakeFirstOrThrow();
    const object = await env.SUPPORT_BUCKET.get(row.storageKey);
    expect(object?.httpMetadata?.contentType).toBe("application/octet-stream");
  });

  test("a disallowed type refuses the whole submission rather than storing it without the file", async () => {
    // The submitter is right there holding the screenshot. Silently dropping it means the first reply
    // asks for a file they believed they had already sent.
    const code = await codeOf(() =>
      submit(
        { attachments: [{ filename: "page.html", contentType: "text/html", bytes: new Uint8Array([1]) }] },
        { bucket: env.SUPPORT_BUCKET },
      ),
    );
    expect(code).toBe("validation/invalid_input");
    expect(await db.selectFrom(SUPPORT_MESSAGES_TABLE).selectAll().execute()).toEqual([]);
  });

  test("more files than the count bound refuses before one byte is written", async () => {
    const many = Array.from({ length: 4 }, (_, index) => ({ ...png, filename: `shot-${index}.png` }));
    expect(await codeOf(() => submit({ attachments: many }, { bucket: env.SUPPORT_BUCKET }))).toBe(
      "validation/invalid_input",
    );
    expect(await db.selectFrom(SUPPORT_ATTACHMENTS_TABLE).selectAll().execute()).toEqual([]);
  });

  test("a declared filename is sanitised on the way in, exactly as the mail path sanitises one", async () => {
    // `SupportAttachment.filename` states the column holds a name "after stripping path separators and
    // control characters". Two producers of one column must guarantee the same thing about it — and
    // this channel is the more attacker-friendly of the two, because the name is a JSON string a
    // signed-in client picks byte for byte rather than something that had to survive MIME encoding.
    await submit(
      {
        attachments: [
          // A right-to-left override renders this as `shotexe.png` in a console — the oldest
          // attachment trick there is — and the separators are what a `Content-Disposition` would
          // carry.
          { ...png, filename: HOSTILE_FILENAME },
        ],
      },
      { bucket: env.SUPPORT_BUCKET },
    );

    const row = await db.selectFrom(SUPPORT_ATTACHMENTS_TABLE).selectAll().executeTakeFirstOrThrow();
    expect(row.filename).not.toContain("/");
    expect(row.filename).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
    expect(row.filename).toBe(safeFilename(HOSTILE_FILENAME));
  });

  test("with no bucket bound the report is still stored, and says how many files were not", async () => {
    const outcome = await submit({ attachments: [png] });
    expect(outcome.attachments).toBe(0);
    expect(await db.selectFrom(SUPPORT_MESSAGES_TABLE).selectAll().execute()).toHaveLength(1);
  });
});
