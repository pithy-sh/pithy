// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import type { MigrationProvider } from "kysely/migration";
import { beforeEach, describe, expect, test } from "vitest";
import { SUPPORT_MIGRATION_ORDER } from "../capability";
import { UNCATEGORIZED } from "../data/enums";
import { SUPPORT_THREADS_TABLE, supportDatabase } from "../data/tables";
import { SupportThread } from "../data/thread";
import { SUPPORT_MIGRATIONS } from "../migrations/set";
import { type AssignThreadOptions, assignThread, listAssignments } from "./assignment";
import { readThread } from "./threads";

/**
 * Assignment against real D1: the four columns the thread carries, the history row each real change
 * appends, and the no-op that a change to the current assignee is.
 */

const T0 = 1_700_000_000_000;
const db = supportDatabase(env.DB);

function provider(): MigrationProvider {
  const registry = createMigrationRegistry([
    { database: "app", namespace: "support", order: SUPPORT_MIGRATION_ORDER, migrations: SUPPORT_MIGRATIONS },
  ]);
  const found = registry.app;
  if (!found) throw new Error('expected a provider for database "app"');
  return found;
}

async function seedThread(id: string): Promise<void> {
  const at = new Date(T0);
  await db
    .insertInto(SUPPORT_THREADS_TABLE)
    .values(
      SupportThread.encode({
        id,
        channel: "email",
        inboxAddress: "support@help.example.com",
        subject: "Hi",
        fromAddress: "ada@example.com",
        fromName: null,
        senderAuthenticated: true,
        userId: null,
        category: UNCATEGORIZED,
        priority: "normal",
        sentiment: "neutral",
        confidence: null,
        model: null,
        classifiedAt: null,
        archived: false,
        archivedAt: null,
        archivedBy: null,
        messageCount: 1,
        firstMessageAt: at,
        lastMessageAt: at,
        createdAt: at,
        updatedAt: at,
      }),
    )
    .execute();
}

let counter = 0;
function options(overrides: Partial<AssignThreadOptions> = {}): AssignThreadOptions {
  return {
    threadId: "t1",
    assignee: { ref: "ada", name: "Ada" },
    actorType: "control-plane",
    assignedBy: "operator-1",
    newId: () => `a-${++counter}`,
    now: new Date(T0 + 1_000),
    ...overrides,
  };
}

beforeEach(async () => {
  counter = 0;
  for (const table of [
    "pithy_support_search",
    "pithy_support_assignments",
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
  await seedThread("t1");
});

describe("assignThread", () => {
  test("sets the four columns, and says who had it before", async () => {
    const result = await assignThread(env.DB, options({ note: "Billing is yours." }));
    expect(result.changed).toBe(true);
    expect(result.previous).toBeNull();
    expect(result.thread).toMatchObject({
      assigneeRef: "ada",
      assigneeName: "Ada",
      assignedBy: "operator-1",
    });
    expect(result.thread.assignedAt?.getTime()).toBe(T0 + 1_000);
    expect(result.thread.updatedAt.getTime()).toBe(T0 + 1_000);

    const stored = (await readThread(db, "t1")).thread;
    expect(stored).toMatchObject({ assigneeRef: "ada", assigneeName: "Ada", assignedBy: "operator-1" });
    expect(stored.assignedAt?.getTime()).toBe(T0 + 1_000);
  });

  test("null clears all four", async () => {
    await assignThread(env.DB, options());
    const result = await assignThread(env.DB, options({ assignee: null, assignedBy: "operator-2" }));
    expect(result.changed).toBe(true);
    expect(result.previous).toEqual({ ref: "ada", name: "Ada" });
    const stored = (await readThread(db, "t1")).thread;
    expect(stored.assigneeRef ?? null).toBeNull();
    expect(stored.assigneeName ?? null).toBeNull();
    expect(stored.assignedAt ?? null).toBeNull();
    expect(stored.assignedBy ?? null).toBeNull();
  });

  test("every change is kept, oldest first, with who had it before and the note", async () => {
    await assignThread(env.DB, options({ note: "Billing is yours." }));
    await assignThread(
      env.DB,
      options({
        assignee: { ref: "grace", name: "Grace" },
        actorType: "user",
        assignedBy: "u-7",
        now: new Date(T0 + 2_000),
      }),
    );
    await assignThread(env.DB, options({ assignee: null, now: new Date(T0 + 3_000) }));

    const history = await listAssignments(db, "t1");
    expect(
      history.map((row) => ({
        to: row.assigneeRef ?? null,
        from: row.previousRef ?? null,
        fromName: row.previousName ?? null,
        by: row.assignedBy,
        actorType: row.actorType,
        note: row.note ?? null,
        at: row.createdAt.getTime(),
      })),
    ).toEqual([
      {
        to: "ada",
        from: null,
        fromName: null,
        by: "operator-1",
        actorType: "control-plane",
        note: "Billing is yours.",
        at: T0 + 1_000,
      },
      { to: "grace", from: "ada", fromName: "Ada", by: "u-7", actorType: "user", note: null, at: T0 + 2_000 },
      {
        to: null,
        from: "grace",
        fromName: "Grace",
        by: "operator-1",
        actorType: "control-plane",
        note: null,
        at: T0 + 3_000,
      },
    ]);
  });

  test("assigning the current assignee again changes nothing and records nothing", async () => {
    await assignThread(env.DB, options());
    const again = await assignThread(
      env.DB,
      options({ assignee: { ref: "ada", name: "Ada L." }, assignedBy: "operator-2", now: new Date(T0 + 5_000) }),
    );
    expect(again.changed).toBe(false);
    expect(again.thread).toMatchObject({ assigneeRef: "ada", assigneeName: "Ada", assignedBy: "operator-1" });
    expect(again.thread.assignedAt?.getTime()).toBe(T0 + 1_000);
    expect(await listAssignments(db, "t1")).toHaveLength(1);
  });

  test("unassigning a thread nobody has changes nothing and records nothing", async () => {
    const result = await assignThread(env.DB, options({ assignee: null }));
    expect(result.changed).toBe(false);
    expect(await listAssignments(db, "t1")).toEqual([]);
  });

  test("throws support/not_found for a thread that does not exist", async () => {
    await expect(assignThread(env.DB, options({ threadId: "ghost" }))).rejects.toMatchObject({
      payload: { code: "support/not_found" },
    });
  });

  test("a history row that cannot be written leaves the thread as it was, so a retry still records the change", async () => {
    await assignThread(env.DB, options({ newId: () => "taken" }));
    // The history id is already used, so the history insert fails on its primary key.
    await expect(
      assignThread(
        env.DB,
        options({ assignee: { ref: "grace", name: "Grace" }, newId: () => "taken", now: new Date(T0 + 2_000) }),
      ),
    ).rejects.toThrow();
    const stored = (await readThread(db, "t1")).thread;
    expect(stored).toMatchObject({ assigneeRef: "ada", assigneeName: "Ada" });
    expect(stored.assignedAt?.getTime()).toBe(T0 + 1_000);
    expect(await listAssignments(db, "t1")).toHaveLength(1);

    const retry = await assignThread(
      env.DB,
      options({ assignee: { ref: "grace", name: "Grace" }, now: new Date(T0 + 3_000) }),
    );
    expect(retry.changed).toBe(true);
    expect(retry.previous).toEqual({ ref: "ada", name: "Ada" });
    expect((await listAssignments(db, "t1")).map((row) => row.assigneeRef)).toEqual(["ada", "grace"]);
  });

  test("two handovers racing from one state both land in the history, and the thread holds the last", async () => {
    await assignThread(env.DB, options());
    const [first, second] = await Promise.all([
      assignThread(env.DB, options({ assignee: { ref: "grace", name: "Grace" }, now: new Date(T0 + 2_000) })),
      assignThread(env.DB, options({ assignee: { ref: "linus", name: "Linus" }, now: new Date(T0 + 2_000) })),
    ]);
    expect(first.changed && second.changed).toBe(true);
    const history = await listAssignments(db, "t1");
    expect(history).toHaveLength(3);
    // Each change names the assignee it actually replaced, so the chain is unbroken.
    const stored = (await readThread(db, "t1")).thread;
    const last = history[2];
    expect(stored.assigneeRef).toBe(last?.assigneeRef);
    expect(history[2]?.previousRef).toBe(history[1]?.assigneeRef);
  });
});
