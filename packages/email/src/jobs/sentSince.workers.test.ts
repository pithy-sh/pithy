// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, test } from "vitest";
import { EmailJob } from "../data/emailJob";
import { emailDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { enqueueEmail } from "../send/enqueue";
import { defaultTheme, type EmailTheme } from "../templates/theme";
import { sentSince } from "./read";

/**
 * `sentSince` against a real D1, because every way this can be wrong is a way SQLite is quiet about.
 *
 * The reader's answer decides whether a message goes out, and the two failure directions are not
 * symmetric. Reporting a send that did not happen withholds a letter. **Missing a send that did happen
 * sends a second copy** — or, where the caller is deciding who to send a *correction* to, withholds the
 * correction from exactly the person owed one. So the tests that matter most here are the ones that
 * plant a row and demand it be found, not the ones that demand a row be excluded.
 *
 * Driven through `enqueueEmail` wherever the question is about what the write path stored. A fixture
 * inserting `recipientKey` itself would prove only that this file can spell it.
 */

const NOW = new Date("2026-06-18T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const theme: EmailTheme = { ...defaultTheme, appName: "Acme", footerAddress: "1 Market St" };

function db() {
  return emailDatabase(env.DB);
}

let sequence = 0;

/** Enqueue one real job, through the real write path. `magicLink` and `welcome` are both registered. */
async function enqueue(options: { to: string; template?: "magicLink" | "welcome"; at?: Date }): Promise<string> {
  const id = `job-${++sequence}`;
  const template = options.template ?? "magicLink";
  await enqueueEmail(
    {
      db: db(),
      fromAddress: "noreply@acme.test",
      fromName: "Acme",
      theme,
      now: options.at ?? NOW,
      newId: () => id,
    },
    {
      to: options.to,
      template,
      payload:
        template === "magicLink"
          ? { url: "https://acme.test/s", expiresMinutes: 15 }
          : { name: "Ada", ctaUrl: "https://acme.test/start", ctaLabel: "Open your dashboard" },
    },
  );
  return id;
}

/** Insert a row directly — for the cases that are about a row this deployment did not write. */
async function insertRaw(row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  await env.DB.prepare(
    `insert into pithy_email_jobs (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
  )
    .bind(...Object.values(row))
    .run();
}

beforeEach(async () => {
  sequence = 0;
  await env.DB.prepare("drop table if exists pithy_email_jobs").run();
  await env.DB.prepare("drop table if exists pithy_email_events").run();
  await email_0001_init.up(db());
});

describe("sentSince — has this template already gone to this person", () => {
  test("finds the job the caller is asking about, and carries its status rather than a yes", async () => {
    const id = await enqueue({ to: "ada@example.com" });

    const log = await sentSince(db(), {
      to: "ada@example.com",
      template: "magicLink",
      since: new Date(NOW.getTime() - HOUR_MS),
    });

    expect(log.items).toEqual([{ id, status: "pending", createdAt: NOW, sentAt: null }]);
    expect(log.truncated).toBe(false);
  });

  test("a failed send is not a letter anybody read, and says so", async () => {
    const id = await enqueue({ to: "ada@example.com" });
    await db().updateTable("pithyEmailJobs").set({ status: "failed" }).where("id", "=", id).execute();

    const log = await sentSince(db(), {
      to: "ada@example.com",
      template: "magicLink",
      since: new Date(NOW.getTime() - HOUR_MS),
    });

    expect(log.items.map((job) => job.status)).toEqual(["failed"]);
  });

  test("another template to the same person is not this template", async () => {
    await enqueue({ to: "ada@example.com", template: "welcome" });

    const log = await sentSince(db(), {
      to: "ada@example.com",
      template: "magicLink",
      since: new Date(NOW.getTime() - HOUR_MS),
    });

    expect(log.items).toEqual([]);
  });

  test("the same template to somebody else is not this person", async () => {
    await enqueue({ to: "grace@example.com" });

    const log = await sentSince(db(), {
      to: "ada@example.com",
      template: "magicLink",
      since: new Date(NOW.getTime() - HOUR_MS),
    });

    expect(log.items).toEqual([]);
  });

  /**
   * The case that decides whether this reader is usable at all.
   *
   * `pithy_email_jobs.to_address` holds the string the caller typed, on purpose — an operator
   * diagnosing a send needs the address that was actually addressed. So a reader matching on it would
   * answer "never sent" for a person enqueued as `Ada@` and asked about as `ada@`, and answering
   * "never sent" is the direction that sends a second copy. `recipientKey` is the normalised column
   * both sides agree on, and this is the test that it is written by the real path.
   */
  test("case and surrounding whitespace do not split one mailbox into two", async () => {
    const id = await enqueue({ to: "  Ada.Lovelace@Example.COM " });

    for (const asked of ["ada.lovelace@example.com", "ADA.LOVELACE@EXAMPLE.COM", " Ada.Lovelace@Example.com "]) {
      const log = await sentSince(db(), {
        to: asked,
        template: "magicLink",
        since: new Date(NOW.getTime() - HOUR_MS),
      });
      expect(
        log.items.map((job) => job.id),
        `asked as ${asked}`,
      ).toEqual([id]);
    }

    // And the row kept what was typed, which is the reason the key had to be a column of its own.
    const row = await db().selectFrom("pithyEmailJobs").select("toAddress").where("id", "=", id).executeTakeFirst();
    expect(row?.toAddress).toBe("  Ada.Lovelace@Example.COM ");
  });

  test("`since` is inclusive at the instant and excludes what came before it", async () => {
    const older = new Date(NOW.getTime() - 2 * HOUR_MS);
    await enqueue({ to: "ada@example.com", at: older });
    const boundary = await enqueue({ to: "ada@example.com", at: NOW });

    const log = await sentSince(db(), { to: "ada@example.com", template: "magicLink", since: NOW });

    expect(log.items.map((job) => job.id)).toEqual([boundary]);
  });

  test("newest first, so the most recent decision is the first row", async () => {
    const first = await enqueue({ to: "ada@example.com", at: new Date(NOW.getTime() - 2 * HOUR_MS) });
    const second = await enqueue({ to: "ada@example.com", at: new Date(NOW.getTime() - HOUR_MS) });
    const third = await enqueue({ to: "ada@example.com", at: NOW });

    const log = await sentSince(db(), {
      to: "ada@example.com",
      template: "magicLink",
      since: new Date(NOW.getTime() - 3 * HOUR_MS),
    });

    expect(log.items.map((job) => job.id)).toEqual([third, second, first]);
  });
});

describe("bounds", () => {
  /** Three jobs an hour apart, oldest first in the returned array. */
  async function threeJobs(): Promise<string[]> {
    const ids: string[] = [];
    for (let n = 2; n >= 0; n -= 1) {
      ids.unshift(await enqueue({ to: "ada@example.com", at: new Date(NOW.getTime() - n * HOUR_MS) }));
    }
    return ids;
  }

  const since = new Date(NOW.getTime() - 24 * HOUR_MS);

  test("a cap that bit says so, rather than passing off a page as the whole answer", async () => {
    await threeJobs();

    const log = await sentSince(db(), { to: "ada@example.com", template: "magicLink", since, limit: 2 });

    expect(log.items).toHaveLength(2);
    expect(log.truncated).toBe(true);
  });

  test("a cap that did not bite reports false, so `truncated` means something", async () => {
    await threeJobs();

    const log = await sentSince(db(), { to: "ada@example.com", template: "magicLink", since, limit: 3 });

    expect(log.items).toHaveLength(3);
    expect(log.truncated).toBe(false);
  });

  /**
   * The cap bounds what comes *back*; the index is what bounds the work done to find it.
   *
   * Without one, "has this gone out" is a full scan of every email the project ever queued, on the path
   * that decides whether to send — and it stays correct while getting slower for years, which is why no
   * assertion about results can catch it. So the plan is asserted directly.
   */
  test("the question is answered from the index, not by scanning the send log", async () => {
    const plan = await env.DB.prepare(
      "explain query plan select id, status, created_at, sent_at from pithy_email_jobs where recipient_key = ? and template = ? and created_at >= ? order by created_at desc, id desc limit ?",
    )
      .bind("ada@example.com", "magicLink", 0, 26)
      .all<{ detail: string }>();
    const detail = plan.results.map((row) => row.detail).join(" | ");

    expect(detail).toContain("pithy_email_jobs_recipient_template_idx");
    expect(detail).not.toContain("SCAN pithy_email_jobs");
  });

  test("an unreasonable limit is clamped, not honoured — the log is unbounded", async () => {
    await threeJobs();

    const log = await sentSince(db(), { to: "ada@example.com", template: "magicLink", since, limit: 10_000 });

    // Clamped to MAX_PAGE_SIZE by core's `pageLimit`; three rows exist, so nothing is cut.
    expect(log.items).toHaveLength(3);
    expect(log.truncated).toBe(false);
  });
});

describe("the trust boundary", () => {
  /** The columns a job row cannot be inserted without. */
  function bareRow(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      id: "job-x",
      to_address: "ada@example.com",
      recipient_key: "ada@example.com",
      from_address: "noreply@acme.test",
      from_name: "Acme",
      subject: "Your sign-in link",
      template: "magicLink",
      category: "transactional",
      payload: "{}",
      status: "sent",
      mode: "immediate",
      attempts: 1,
      send_at: NOW.getTime(),
      open_tracking: 0,
      click_tracking: 0,
      created_at: NOW.getTime(),
      updated_at: NOW.getTime(),
      ...overrides,
    };
  }

  const ask = () =>
    sentSince(db(), {
      to: "ada@example.com",
      template: "magicLink",
      since: new Date(NOW.getTime() - HOUR_MS),
    });

  /**
   * A row this schema cannot read stops the decision instead of quietly biasing it.
   *
   * Skipping it would be the friendlier code and the worse behaviour: the caller would be told the
   * message never went, and would send it again.
   */
  test("a status outside the enum throws rather than being dropped from the answer", async () => {
    await insertRaw(bareRow({ status: "definitely-sent" }));

    await expect(ask()).rejects.toThrow(PithyError);
  });

  test("a date column holding text throws rather than decoding to something arbitrary", async () => {
    await insertRaw(bareRow({ created_at: NOW.getTime(), sent_at: "yesterday" }));

    await expect(ask()).rejects.toThrow(PithyError);
  });

  /**
   * The thrown payload is a `PithyError`, so `clientError` strips `detail` — and `detail` is where the
   * row id goes. Neither half may carry the recipient: the values that failed to parse *are* the row,
   * and the row is somebody's mail.
   */
  test("what it throws names the row and no part of it", async () => {
    await insertRaw(bareRow({ id: "job-corrupt", status: "definitely-sent" }));

    const error = await ask().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(PithyError);
    const payload = (error as PithyError).payload;
    expect(payload.code).toBe("core/internal");
    expect(payload.detail).toContain("job-corrupt");
    for (const text of [payload.message, payload.action ?? "", payload.detail ?? ""]) {
      expect(text).not.toContain("ada@example.com");
      expect(text).not.toContain("definitely-sent");
    }
  });

  /**
   * A projection cannot leak a column it never loaded, and this is the assertion that keeps it that
   * way. `SentSummary` is `EmailJob.pick(…)`, so a column added to the row does not appear here — but a
   * later edit widening the pick would, and the caller of this reader is ordinary application code
   * rather than a scoped credential.
   */
  test("four keys, and the payload is not one of them", async () => {
    await enqueue({ to: "ada@example.com" });

    const log = await sentSince(db(), {
      to: "ada@example.com",
      template: "magicLink",
      since: new Date(NOW.getTime() - HOUR_MS),
    });

    expect(Object.keys(log.items[0] ?? {}).sort()).toEqual(["createdAt", "id", "sentAt", "status"]);
    // Stated against the row schema rather than a list of names, so a new sensitive column is covered
    // the day it lands rather than the day somebody remembers this test.
    const projected = new Set(Object.keys(log.items[0] ?? {}));
    for (const column of Object.keys(EmailJob.shape)) {
      if (["id", "status", "createdAt", "sentAt"].includes(column)) continue;
      expect(projected.has(column), `${column} must not be projected`).toBe(false);
    }
  });
});
