// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { Migration, MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import type { z } from "zod";
import { SUPPORT_MIGRATION_ORDER } from "../capability";
import type { SupportPriority, SupportSentiment } from "../data/enums";
import { UNCATEGORIZED } from "../data/enums";
import { SupportMessage } from "../data/message";
import { SUPPORT_FLAGS_TABLE, SUPPORT_MESSAGES_TABLE, SUPPORT_THREADS_TABLE, supportDatabase } from "../data/tables";
import { SupportThread } from "../data/thread";
import { SupportListedThreadView, SupportMessageView, SupportThreadView } from "../http/responses";
import { listedThreadView, messageView, threadView } from "../http/views";
import { support_0001_threads } from "../migrations/0001_threads";
import { indexMessage } from "./search";
import { createSearchIndex } from "./searchIndex";
import {
  listOwnThreads,
  listThreads,
  MAX_PAGE_SIZE,
  readOwnThread,
  readThread,
  setArchived,
  setFlags,
} from "./threads";

/**
 * The inbox query against real D1 — pagination, filters, and both search backends on live rows.
 *
 * A Workers test rather than a unit test because the two things worth proving here are things only
 * SQLite can answer: that the cursor holds its position while rows are inserted above it, and that a
 * search term is treated as data by `LIKE` and by FTS5 alike.
 */

const VIEWER = "viewer-1";
const T0 = 1_700_000_000_000;
const INBOX = "support@help.example.com";

const db = supportDatabase(env.DB);

/** Build an app-database provider for the given local migration set. */
function provider(migrations: Record<string, Migration>): MigrationProvider {
  const registry = createMigrationRegistry([
    { database: "app", namespace: "support", order: SUPPORT_MIGRATION_ORDER, migrations },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

const BASE = { "0001_threads": support_0001_threads };

/** One thread row, with everything the inbox does not filter on left at a sensible default. */
function threadRow(seed: {
  id: string;
  lastMessageAt: number;
  category?: string;
  priority?: SupportPriority;
  sentiment?: SupportSentiment;
  inbox?: string;
  archived?: boolean;
  subject?: string;
}): z.input<typeof SupportThread> {
  const at = new Date(seed.lastMessageAt);
  return SupportThread.encode({
    id: seed.id,
    channel: "email",
    inboxAddress: seed.inbox ?? INBOX,
    subject: seed.subject ?? `Thread ${seed.id}`,
    fromAddress: "ada@example.com",
    fromName: null,
    senderAuthenticated: true,
    userId: null,
    category: seed.category ?? UNCATEGORIZED,
    priority: seed.priority ?? "normal",
    sentiment: seed.sentiment ?? "neutral",
    confidence: null,
    model: null,
    classifiedAt: null,
    archived: seed.archived ?? false,
    archivedAt: null,
    archivedBy: null,
    messageCount: 1,
    firstMessageAt: at,
    lastMessageAt: at,
    createdAt: at,
    updatedAt: at,
  });
}

/** Insert one thread. */
async function seedThread(seed: Parameters<typeof threadRow>[0]): Promise<void> {
  await db.insertInto(SUPPORT_THREADS_TABLE).values(threadRow(seed)).execute();
}

/** Insert one message. */
async function seedMessage(seed: {
  id: string;
  threadId: string;
  subject: string;
  body: string;
  receivedAt?: number;
}): Promise<void> {
  const at = new Date(seed.receivedAt ?? T0);
  await db
    .insertInto(SUPPORT_MESSAGES_TABLE)
    .values(
      SupportMessage.encode({
        id: seed.id,
        threadId: seed.threadId,
        direction: "inbound",
        channel: "email" as const,
        submittedByUserId: null,
        context: null,
        mimeMessageId: `${seed.id}@mail.example.com`,
        mimeInReplyTo: null,
        mimeReferences: null,
        fromAddress: "ada@example.com",
        fromName: null,
        toAddress: INBOX,
        subject: seed.subject,
        textBody: seed.body,
        htmlBody: null,
        emailJobId: null,
        rawKey: null,
        rawBytes: null,
        receivedAt: at,
        createdAt: at,
      }),
    )
    .execute();
}

/** The ids a page returned, in the order it returned them. */
const ids = (page: { threads: SupportThread[] }): string[] => page.threads.map((thread) => thread.id);

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
  await runMigrations(env.DB, provider(BASE));
});

describe("listThreads", () => {
  test("returns threads newest first", async () => {
    await seedThread({ id: "middle", lastMessageAt: T0 + 200 });
    await seedThread({ id: "newest", lastMessageAt: T0 + 300 });
    await seedThread({ id: "oldest", lastMessageAt: T0 + 100 });

    expect(ids(await listThreads(db, {}, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) }))).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  test("leaves archived threads out until they are asked for", async () => {
    await seedThread({ id: "open", lastMessageAt: T0 + 200 });
    await seedThread({ id: "done", lastMessageAt: T0 + 300, archived: true });

    // The default matters more than the filter: an inbox that showed resolved threads is not a work
    // queue, and `archived` is absent from most callers' queries.
    expect(ids(await listThreads(db, {}, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) }))).toEqual([
      "open",
    ]);
    expect(
      ids(await listThreads(db, { archived: true }, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) })),
    ).toEqual(["done"]);
  });

  test("the console filters by channel, and shows both when it does not", async () => {
    await seedThread({ id: "by-mail", lastMessageAt: T0 + 200 });
    await db
      .insertInto(SUPPORT_THREADS_TABLE)
      .values(
        SupportThread.encode({
          ...SupportThread.parse(threadRow({ id: "in-app", lastMessageAt: T0 + 100 })),
          id: "in-app",
          channel: "app",
        }),
      )
      .execute();

    const now = new Date(T0 + 10_000_000);
    // Absent is both, because the inbox is one queue however things arrived — that is the argument for
    // this being a channel rather than a second capability.
    expect(ids(await listThreads(db, {}, { fts: false, viewer: VIEWER, now }))).toEqual(["by-mail", "in-app"]);
    expect(ids(await listThreads(db, { channel: "app" }, { fts: false, viewer: VIEWER, now }))).toEqual(["in-app"]);
    expect(ids(await listThreads(db, { channel: "email" }, { fts: false, viewer: VIEWER, now }))).toEqual(["by-mail"]);
  });

  test("category, priority, sentiment, and inbox each narrow the page", async () => {
    await seedThread({ id: "billing", lastMessageAt: T0 + 400, category: "billing" });
    await seedThread({ id: "urgent", lastMessageAt: T0 + 300, priority: "urgent" });
    await seedThread({ id: "angry", lastMessageAt: T0 + 200, sentiment: "angry" });
    await seedThread({ id: "security", lastMessageAt: T0 + 100, inbox: "security@help.example.com" });

    expect(
      ids(
        await listThreads(db, { category: "billing" }, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) }),
      ),
    ).toEqual(["billing"]);
    expect(
      ids(
        await listThreads(db, { priority: "urgent" }, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) }),
      ),
    ).toEqual(["urgent"]);
    expect(
      ids(
        await listThreads(db, { sentiment: "angry" }, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) }),
      ),
    ).toEqual(["angry"]);
    expect(
      ids(
        await listThreads(
          db,
          { inbox: "security@help.example.com" },
          { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) },
        ),
      ),
    ).toEqual(["security"]);
  });

  test("the filters compose, rather than the last one winning", async () => {
    await seedThread({ id: "both", lastMessageAt: T0 + 400, category: "billing", priority: "urgent" });
    await seedThread({ id: "category-only", lastMessageAt: T0 + 300, category: "billing" });
    await seedThread({ id: "priority-only", lastMessageAt: T0 + 200, priority: "urgent" });

    const page = await listThreads(
      db,
      { category: "billing", priority: "urgent" },
      { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) },
    );
    expect(ids(page)).toEqual(["both"]);
  });

  test("a thread arriving mid-read is neither skipped nor repeated on the next page", async () => {
    for (const at of [400, 300, 200, 100]) await seedThread({ id: `t-${at}`, lastMessageAt: T0 + at });

    const first = await listThreads(db, { limit: 2 }, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) });
    expect(ids(first)).toEqual(["t-400", "t-300"]);

    // Mail lands at the front of the order while the operator is still reading. This is the failure
    // the whole cursor design exists to remove: under `OFFSET 2` the next page would start at t-300 —
    // a thread the reader has already seen — and t-100 would fall off the end unread, silently.
    await seedThread({ id: "t-500", lastMessageAt: T0 + 500 });

    const second = await listThreads(
      db,
      { cursor: first.nextCursor ?? undefined, limit: 2 },
      { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) },
    );
    expect(ids(second)).toEqual(["t-200", "t-100"]);
  });

  test("two threads sharing a timestamp still split cleanly across a page boundary", async () => {
    // `lastMessageAt` is not unique, and a boundary landing between two threads that share one is
    // exactly where a dropped row would hide. The id tiebreak in the cursor is what stops it.
    await seedThread({ id: "b", lastMessageAt: T0 + 100 });
    await seedThread({ id: "a", lastMessageAt: T0 + 100 });

    const first = await listThreads(db, { limit: 1 }, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) });
    const second = await listThreads(
      db,
      { cursor: first.nextCursor ?? undefined, limit: 1 },
      { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) },
    );
    expect([...ids(first), ...ids(second)]).toEqual(["b", "a"]);
  });

  test("nextCursor is null on the last page", async () => {
    await seedThread({ id: "one", lastMessageAt: T0 + 200 });
    await seedThread({ id: "two", lastMessageAt: T0 + 100 });

    const first = await listThreads(db, { limit: 1 }, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) });
    expect(first.nextCursor).not.toBeNull();

    const second = await listThreads(
      db,
      { cursor: first.nextCursor ?? undefined, limit: 1 },
      { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) },
    );
    expect(second.nextCursor).toBeNull();
  });

  test("a malformed cursor reads as a first page rather than an error", async () => {
    await seedThread({ id: "newest", lastMessageAt: T0 + 200 });
    await seedThread({ id: "oldest", lastMessageAt: T0 + 100 });

    // A truncated or hand-edited cursor arrives from a client, so it is bad input rather than a
    // server fault — the caller gets the top of the inbox, not a 500.
    const page = await listThreads(
      db,
      { cursor: "not-a-cursor" },
      { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) },
    );
    expect(ids(page)).toEqual(["newest", "oldest"]);
  });

  test("limit is capped at MAX_PAGE_SIZE, whatever the caller asks for", async () => {
    const rows = Array.from({ length: MAX_PAGE_SIZE + 1 }, (_, index) =>
      threadRow({ id: `t-${index}`, lastMessageAt: T0 + index }),
    );
    // D1 binds at most 100 parameters per statement, and a thread row is 21 columns — so batches of
    // four. Sized with headroom deliberately: a batch tuned to exactly the limit turns the next
    // column anyone adds to this table into a failure in an unrelated pagination test.
    for (let index = 0; index < rows.length; index += 4) {
      await db
        .insertInto(SUPPORT_THREADS_TABLE)
        .values(rows.slice(index, index + 4))
        .execute();
    }

    const page = await listThreads(db, { limit: 5000 }, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) });
    expect(page.threads).toHaveLength(MAX_PAGE_SIZE);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe("listThreads — search over the LIKE scan", () => {
  beforeEach(async () => {
    await seedThread({ id: "refund", lastMessageAt: T0 + 300 });
    await seedThread({ id: "login", lastMessageAt: T0 + 200 });
    await seedMessage({ id: "m1", threadId: "refund", subject: "Money problem", body: "I was charged twice" });
    await seedMessage({ id: "m2", threadId: "login", subject: "Cannot log in", body: "the link never arrived" });
  });

  test("finds a word in a message body", async () => {
    expect(
      ids(await listThreads(db, { q: "charged" }, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) })),
    ).toEqual(["refund"]);
  });

  test("finds a word in a subject, not only in a body", async () => {
    expect(
      ids(await listThreads(db, { q: "Cannot log" }, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) })),
    ).toEqual(["login"]);
  });

  test("a term containing % matches a literal percent sign", async () => {
    await seedThread({ id: "discount", lastMessageAt: T0 + 400 });
    await seedThread({ id: "invoice", lastMessageAt: T0 + 100 });
    await seedMessage({ id: "m3", threadId: "discount", subject: "Coupon", body: "the 50% code was refused" });
    await seedMessage({ id: "m4", threadId: "invoice", subject: "Invoice", body: "line item 5000 is wrong" });

    // Unescaped, `%50%%` is a wildcard either side of "50" and matches the 5000 invoice too. Escaping
    // is what keeps a search term data rather than pattern syntax.
    expect(
      ids(await listThreads(db, { q: "50%" }, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) })),
    ).toEqual(["discount"]);
  });

  test("searches every filter alongside it, rather than replacing them", async () => {
    await seedThread({ id: "archived-refund", lastMessageAt: T0 + 400, archived: true });
    await seedMessage({ id: "m5", threadId: "archived-refund", subject: "Money", body: "I was charged twice" });

    expect(
      ids(await listThreads(db, { q: "charged" }, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) })),
    ).toEqual(["refund"]);
  });
});

describe("listThreads — search over the FTS5 index", () => {
  beforeEach(async () => {
    await runMigrations(env.DB, provider(BASE));
    await createSearchIndex(db);
  });

  /** Store a message and index it, the way ingest and the reply path both do. */
  async function seedIndexed(seed: { id: string; threadId: string; subject: string; body: string }): Promise<void> {
    await seedMessage(seed);
    await indexMessage(db, {
      threadId: seed.threadId,
      messageId: seed.id,
      subject: seed.subject,
      body: seed.body,
    });
  }

  test("finds the same words the LIKE scan finds", async () => {
    await seedThread({ id: "refund", lastMessageAt: T0 + 300 });
    await seedThread({ id: "login", lastMessageAt: T0 + 200 });
    await seedIndexed({ id: "m1", threadId: "refund", subject: "Money problem", body: "I was charged twice" });
    await seedIndexed({ id: "m2", threadId: "login", subject: "Cannot log in", body: "the link never arrived" });

    expect(
      ids(await listThreads(db, { q: "charged" }, { fts: true, viewer: VIEWER, now: new Date(T0 + 10_000_000) })),
    ).toEqual(["refund"]);
    expect(
      ids(await listThreads(db, { q: "Cannot" }, { fts: true, viewer: VIEWER, now: new Date(T0 + 10_000_000) })),
    ).toEqual(["login"]);
  });

  test("FTS5 operator syntax in a query is searched for, never obeyed", async () => {
    await seedThread({ id: "literal", lastMessageAt: T0 + 300 });
    await seedThread({ id: "other", lastMessageAt: T0 + 200 });
    await seedIndexed({ id: "m1", threadId: "literal", subject: "Terms", body: "alpha NOT beta" });
    await seedIndexed({ id: "m2", threadId: "other", subject: "Terms", body: "alpha gamma" });

    // "Input is data, never syntax", applied to the search box. Read as FTS5 syntax, `alpha NOT beta`
    // means "alpha without beta" and would return the *other* thread; quoted, it is three words and
    // returns the one that actually contains them. A customer named Ng, an error string with an
    // asterisk, or somebody probing all land here.
    expect(
      ids(
        await listThreads(db, { q: "alpha NOT beta" }, { fts: true, viewer: VIEWER, now: new Date(T0 + 10_000_000) }),
      ),
    ).toEqual(["literal"]);
    // `OR` likewise: as an operator this would match both threads; as a word it matches neither.
    expect(
      ids(
        await listThreads(db, { q: "alpha OR gamma" }, { fts: true, viewer: VIEWER, now: new Date(T0 + 10_000_000) }),
      ),
    ).toEqual([]);
  });
});

describe("readThread", () => {
  test("returns the messages oldest first — a conversation reads downward", async () => {
    await seedThread({ id: "t1", lastMessageAt: T0 + 300 });
    await seedMessage({ id: "last", threadId: "t1", subject: "Re", body: "still stuck", receivedAt: T0 + 300 });
    await seedMessage({ id: "first", threadId: "t1", subject: "Hi", body: "cannot log in", receivedAt: T0 + 100 });
    await seedMessage({ id: "middle", threadId: "t1", subject: "Re", body: "any news", receivedAt: T0 + 200 });

    const detail = await readThread(db, "t1");
    expect(detail.messages.map((message) => message.id)).toEqual(["first", "middle", "last"]);
    expect(detail.thread.id).toBe("t1");
  });

  test("throws support/not_found for a thread that does not exist", async () => {
    await expect(readThread(db, "ghost")).rejects.toMatchObject({ payload: { code: "support/not_found" } });
  });
});

describe("the submitter's read-back", () => {
  /** An app thread owned by `userId`, so the read-back has something to be scoped against. */
  async function seedAppThread(id: string, userId: string | null, lastMessageAt: number): Promise<void> {
    await db
      .insertInto(SUPPORT_THREADS_TABLE)
      .values(
        SupportThread.encode({
          ...SupportThread.parse(threadRow({ id, lastMessageAt })),
          id,
          channel: "app",
          userId,
          accountLinkSource: userId ? "session" : null,
        }),
      )
      .execute();
  }

  test("lists this account's own app threads, newest first", async () => {
    await seedAppThread("mine-old", "user-ada", T0 + 100);
    await seedAppThread("mine-new", "user-ada", T0 + 300);
    await seedAppThread("someone-else", "user-grace", T0 + 200);

    const page = await listOwnThreads(db, "user-ada", {});
    expect(ids(page)).toEqual(["mine-new", "mine-old"]);
  });

  test("an archived thread is still the submitter's to read", async () => {
    // The operator inbox hides done threads because it is a work queue. A person looking at their own
    // requests is looking for the one that was answered.
    await seedAppThread("mine", "user-ada", T0 + 100);
    await setArchived(db, "mine", true, "ops", new Date(T0 + 200));

    expect(ids(await listOwnThreads(db, "user-ada", {}))).toEqual(["mine"]);
    await expect(readOwnThread(db, "mine", "user-ada")).resolves.toMatchObject({ thread: { id: "mine" } });
  });

  test("an email thread linked to the same account is never in the read-back", async () => {
    // The link on a mail thread was matched against an address in a header nobody proved. Serving it
    // to whoever currently holds that address would turn the mail path's known weakness into a read
    // primitive — which is exactly the trade the in-app channel exists to avoid.
    await seedThread({ id: "by-mail", lastMessageAt: T0 + 400 });
    await db.updateTable(SUPPORT_THREADS_TABLE).set({ userId: "user-ada" }).where("id", "=", "by-mail").execute();
    await seedAppThread("in-app", "user-ada", T0 + 100);

    expect(ids(await listOwnThreads(db, "user-ada", {}))).toEqual(["in-app"]);
    await expect(readOwnThread(db, "by-mail", "user-ada")).rejects.toMatchObject({
      payload: { code: "support/not_found" },
    });
  });

  test("somebody else's thread is indistinguishable from one that does not exist", async () => {
    // A 403 would confirm the id names a real conversation, and on an inbox of other people's
    // correspondence that confirmation is itself the disclosure.
    await seedAppThread("theirs", "user-grace", T0 + 100);
    for (const id of ["theirs", "no-such-thread"]) {
      await expect(readOwnThread(db, id, "user-ada"), id).rejects.toMatchObject({
        payload: { code: "support/not_found" },
      });
    }
  });

  test("the page is cursor-paginated on the same ordering as the inbox", async () => {
    for (let index = 0; index < 3; index += 1) await seedAppThread(`t${index}`, "user-ada", T0 + index * 100);

    const first = await listOwnThreads(db, "user-ada", { limit: 2 });
    expect(ids(first)).toEqual(["t2", "t1"]);
    expect(first.nextCursor).not.toBeNull();

    const second = await listOwnThreads(db, "user-ada", { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(ids(second)).toEqual(["t0"]);
    expect(second.nextCursor).toBeNull();
  });

  test("a limit beyond the page cap is clamped rather than honoured", async () => {
    await seedAppThread("t1", "user-ada", T0 + 100);
    await expect(listOwnThreads(db, "user-ada", { limit: MAX_PAGE_SIZE + 1000 })).resolves.toMatchObject({
      nextCursor: null,
    });
  });
});

describe("setArchived", () => {
  test("records who marked the thread done, and when", async () => {
    await seedThread({ id: "t1", lastMessageAt: T0 + 100 });

    const archived = await setArchived(db, "t1", true, "ada@ops", new Date(T0 + 500));
    expect(archived.archived).toBe(true);
    expect(archived.archivedBy).toBe("ada@ops");
    expect(archived.archivedAt?.getTime()).toBe(T0 + 500);

    const stored = (
      await listThreads(db, { archived: true }, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) })
    ).threads[0];
    expect(stored?.archivedBy).toBe("ada@ops");
  });

  test("reopening clears the archive stamp rather than leaving a stale one", async () => {
    await seedThread({ id: "t1", lastMessageAt: T0 + 100 });
    await setArchived(db, "t1", true, "ada@ops", new Date(T0 + 500));

    const reopened = await setArchived(db, "t1", false, "grace@ops", new Date(T0 + 600));
    expect(reopened.archived).toBe(false);
    // A left-behind `archivedBy` would have the dashboard naming somebody who reopened the thread as
    // the person who closed it.
    expect(reopened.archivedAt).toBeNull();
    expect(reopened.archivedBy).toBeNull();
  });

  test("archiving twice is the same outcome, not a conflict", async () => {
    await seedThread({ id: "t1", lastMessageAt: T0 + 100 });
    await setArchived(db, "t1", true, "ada@ops", new Date(T0 + 500));

    const again = await setArchived(db, "t1", true, "grace@ops", new Date(T0 + 600));
    expect(again.archived).toBe(true);
    expect(again.archivedBy).toBe("grace@ops");
  });

  test("throws support/not_found for a thread that does not exist", async () => {
    await expect(setArchived(db, "ghost", true, "ada@ops", new Date(T0))).rejects.toMatchObject({
      payload: { code: "support/not_found" },
    });
  });
});

describe("setFlags", () => {
  /** The flag rows for a thread, viewer-ordered. */
  async function flags(threadId: string) {
    return db
      .selectFrom(SUPPORT_FLAGS_TABLE)
      .selectAll()
      .where("threadId", "=", threadId)
      .orderBy("viewer", "asc")
      .execute();
  }

  let counter = 0;
  const newId = () => `flag-${++counter}`;

  beforeEach(async () => {
    counter = 0;
    await seedThread({ id: "t1", lastMessageAt: T0 + 100 });
  });

  test("two viewers get independent rows", async () => {
    await setFlags(db, { threadId: "t1", viewer: "ada@ops", read: true, newId, now: new Date(T0) });
    await setFlags(db, { threadId: "t1", viewer: "grace@ops", read: false, newId, now: new Date(T0) });

    // Whether Ada has read a thread says nothing about whether Grace has — the reason these are a
    // table of their own rather than columns on the thread.
    expect((await flags("t1")).map((row) => [row.viewer, row.read])).toEqual([
      ["ada@ops", 1],
      ["grace@ops", 0],
    ]);
  });

  test("the same viewer twice updates one row rather than adding a second", async () => {
    await setFlags(db, { threadId: "t1", viewer: "ada@ops", read: true, newId, now: new Date(T0) });
    await setFlags(db, { threadId: "t1", viewer: "ada@ops", read: false, newId, now: new Date(T0 + 100) });

    const rows = await flags("t1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.read).toBe(0);
  });

  test("an omitted field keeps the value already stored", async () => {
    await setFlags(db, {
      threadId: "t1",
      viewer: "ada@ops",
      read: true,
      snoozedUntil: new Date(T0 + 900),
      newId,
      now: new Date(T0),
    });
    // Marking read must not silently un-snooze: the two flags are set from different places in the
    // dashboard, and each call carries only what it changed.
    await setFlags(db, { threadId: "t1", viewer: "ada@ops", read: false, newId, now: new Date(T0 + 100) });

    const row = (await flags("t1"))[0];
    expect(row?.snoozedUntil).toBe(T0 + 900);
  });

  test("snoozedUntil: null clears a snooze", async () => {
    await setFlags(db, {
      threadId: "t1",
      viewer: "ada@ops",
      snoozedUntil: new Date(T0 + 900),
      newId,
      now: new Date(T0),
    });
    await setFlags(db, { threadId: "t1", viewer: "ada@ops", snoozedUntil: null, newId, now: new Date(T0 + 100) });

    expect((await flags("t1"))[0]?.snoozedUntil).toBeNull();
  });

  test("throws support/not_found for a thread that does not exist", async () => {
    await expect(
      setFlags(db, { threadId: "ghost", viewer: "ada@ops", read: true, newId, now: new Date(T0) }),
    ).rejects.toMatchObject({ payload: { code: "support/not_found" } });
  });
});

describe("per-viewer flags actually affect what a viewer sees", () => {
  /**
   * The gap these close: `setFlags` persisted a snooze and nothing ever read it, so a thread snoozed
   * for a week reappeared in the very next page — a button that did nothing. `read` was likewise
   * stored and never projected, so a dashboard could not render read/unread at all.
   */
  test("a live snooze hides the thread from the viewer who set it", async () => {
    await seedThread({ id: "t-snooze", lastMessageAt: T0 + 100 });
    await setFlags(db, {
      threadId: "t-snooze",
      viewer: VIEWER,
      snoozedUntil: new Date(T0 + 20_000_000),
      newId: () => "f-1",
      now: new Date(T0),
    });

    const page = await listThreads(db, {}, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) });
    expect(page.threads.map((row) => row.id)).not.toContain("t-snooze");
  });

  test("an expired snooze stops hiding it, with nothing having to sweep", async () => {
    await seedThread({ id: "t-expired", lastMessageAt: T0 + 100 });
    await setFlags(db, {
      threadId: "t-expired",
      viewer: VIEWER,
      snoozedUntil: new Date(T0 + 1_000),
      newId: () => "f-2",
      now: new Date(T0),
    });

    const page = await listThreads(db, {}, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) });
    expect(page.threads.map((row) => row.id)).toContain("t-expired");
  });

  test("one viewer's snooze does not hide the thread from anybody else", async () => {
    // The whole reason these are per viewer rather than columns on the thread.
    await seedThread({ id: "t-mine", lastMessageAt: T0 + 100 });
    await setFlags(db, {
      threadId: "t-mine",
      viewer: VIEWER,
      snoozedUntil: new Date(T0 + 20_000_000),
      newId: () => "f-3",
      now: new Date(T0),
    });

    const other = await listThreads(db, {}, { fts: false, viewer: "viewer-2", now: new Date(T0 + 10_000_000) });
    expect(other.threads.map((row) => row.id)).toContain("t-mine");
  });

  test("read is projected onto the listing, and defaults false for a viewer with no row", async () => {
    await seedThread({ id: "t-read", lastMessageAt: T0 + 100 });
    await seedThread({ id: "t-unread", lastMessageAt: T0 + 100 });
    await setFlags(db, { threadId: "t-read", viewer: VIEWER, read: true, newId: () => "f-4", now: new Date(T0) });

    const page = await listThreads(db, {}, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) });
    const byId = new Map(page.threads.map((row) => [row.id, row.read]));
    expect(byId.get("t-read")).toBe(true);
    expect(byId.get("t-unread")).toBe(false);
  });

  test("setting flags twice for one viewer upserts rather than colliding", async () => {
    // The unique index is on (threadId, viewer); a read-then-insert would throw on the second call.
    await seedThread({ id: "t-twice", lastMessageAt: T0 + 100 });
    const write = (read: boolean, id: string) =>
      setFlags(db, { threadId: "t-twice", viewer: VIEWER, read, newId: () => id, now: new Date(T0) });

    await write(true, "f-5");
    await expect(write(false, "f-6")).resolves.toBeUndefined();

    const page = await listThreads(db, {}, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) });
    expect(page.threads.find((row) => row.id === "t-twice")?.read).toBe(false);
  });
});

describe("the index being configured is not the index existing", () => {
  /**
   * `search.fts` is a config flag while the virtual table is a migration, and the two disagree more
   * easily than they should: a project that flipped the flag but has not migrated, a database
   * restored from an older snapshot, a Worker deployed ahead of `pithy migrate`. Every one of those
   * says FTS in config and "no such table" in the schema, and the inbox route must not 500 for it.
   */
  test("falls back to a LIKE scan when the FTS table is absent, rather than failing the inbox", async () => {
    // 0002_search deliberately not applied — `beforeEach` runs BASE only.
    await seedThread({ id: "t1", lastMessageAt: T0 + 100 });
    await seedMessage({ id: "m1", threadId: "t1", subject: "Refund", body: "charged twice" });

    const page = await listThreads(db, { q: "charged" }, { fts: true, viewer: VIEWER, now: new Date(T0 + 1) });
    expect(ids(page)).toEqual(["t1"]);
  });

  test("a real query error still surfaces rather than degrading forever", async () => {
    // The fallback is narrow on purpose: only a missing-table error is caught. Proven by the fact
    // that the FTS path works normally once the migration is applied — a blanket catch would make
    // every future query bug look like a slow search.
    await runMigrations(env.DB, provider(BASE));
    await createSearchIndex(db);
    await seedThread({ id: "t1", lastMessageAt: T0 + 100 });
    await indexMessage(db, { threadId: "t1", messageId: "m1", subject: "Refund", body: "charged twice" });

    const page = await listThreads(db, { q: "charged" }, { fts: true, viewer: VIEWER, now: new Date(T0 + 1) });
    expect(ids(page)).toEqual(["t1"]);
  });
});

describe("the exported response schemas against real rows", () => {
  /**
   * The projections, fed rows that came out of D1 rather than out of a fixture.
   *
   * `http/responses.test.ts` runs the same schemas against hand-built rows, which proves the field
   * lists agree. This proves the other half: that a row as SQLite actually returns it — decoded
   * through the table's own codecs, with the columns a migration really produced — still projects to
   * exactly what the schema declares. A `0`/`1` reaching a boolean field, or an ms-epoch reaching a
   * date one, fails here and nowhere else.
   *
   * Equality rather than a bare parse, because a Zod object strips unknown keys: comparing the parsed
   * value with the projection's output is what catches a field the schema does not know about.
   */
  test("a listed thread, a thread, and a message all match", async () => {
    await seedThread({ id: "t-1", lastMessageAt: T0 + 100, category: "billing", priority: "urgent" });
    await seedMessage({ id: "m-1", threadId: "t-1", subject: "Where is my refund?", body: "Still waiting." });
    await setFlags(db, {
      threadId: "t-1",
      viewer: VIEWER,
      read: true,
      snoozedUntil: new Date(T0 + 90_000),
      newId: () => "flag-1",
      now: new Date(T0),
    });

    const page = await listThreads(db, {}, { fts: false, viewer: VIEWER, now: new Date(T0 + 10_000_000) });
    const listed = page.threads.map(listedThreadView);
    expect(SupportListedThreadView.array().parse(listed)).toEqual(listed);
    expect(listed[0]?.read).toBe(true);
    expect(listed[0]?.snoozedUntil).toBe(new Date(T0 + 90_000).toISOString());

    const detail = await readThread(db, "t-1");
    const thread = threadView(detail.thread);
    expect(SupportThreadView.parse(thread)).toEqual(thread);
    const messages = detail.messages.map(messageView);
    expect(SupportMessageView.array().parse(messages)).toEqual(messages);
  });
});
