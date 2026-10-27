// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { credentialFields, type PurgeContext } from "@pithy-sh/core/src/capability/purge";
import { createDatabase } from "@pithy-sh/core/src/data/db";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { support } from "../capability";
import { SUPPORT_MIGRATIONS } from "../migrations/set";
import { ERASED_ASSIGNER, SUPPORT_PURGE_SUMMARY, supportUserPurge } from "./contribution";

/**
 * Support's part of a person's purge and export (#814), over real D1 and a real Miniflare R2 bucket: a thread linked
 * to the account and one sent from its address before there was an account are both theirs, with every message,
 * attachment and raw mail in them, and the history of who had each (#816), and nobody else's thread is touched.
 */

const TABLES = [
  "pithy_support_assignments",
  "pithy_support_attachments",
  "pithy_support_classifications",
  "pithy_support_thread_flags",
  "pithy_support_messages",
  "pithy_support_threads",
];
const T = 1_700_000_000_000;

const purge = supportUserPurge();

/**
 * D1 refuses a statement with more than 100 bound parameters and R2 a delete of more than 1000 keys; Miniflare
 * enforces neither, so the bindings a purge is handed here do.
 */
function capped(): { DB: D1Database; SUPPORT_BUCKET: R2Bucket } {
  const d1 = env.DB;
  const bucket = env.SUPPORT_BUCKET;
  const DB = new Proxy(d1, {
    get(target, key) {
      if (key === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          return new Proxy(statement, {
            get(inner, name) {
              if (name === "bind") {
                return (...values: unknown[]) => {
                  if (values.length > 100) throw new Error(`D1: ${values.length} bound parameters, over 100`);
                  return inner.bind(...values);
                };
              }
              const value = Reflect.get(inner, name);
              return typeof value === "function" ? value.bind(inner) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const SUPPORT_BUCKET = new Proxy(bucket, {
    get(target, key) {
      if (key === "delete") {
        return (keys: string | string[]) => {
          if (Array.isArray(keys) && keys.length > 1000) throw new Error(`R2: ${keys.length} keys, over 1000`);
          return target.delete(keys);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { DB, SUPPORT_BUCKET };
}

const context = (id: string, address: string | null): PurgeContext => ({
  subject: { type: "user", id },
  env: capped(),
  address: async () => address,
});

async function exportOf(input: PurgeContext): Promise<Record<string, unknown>> {
  if (!purge.export) throw new Error("no export declared");
  return purge.export(input);
}

async function thread(id: string, userId: string | null, fromAddress: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO pithy_support_threads (id, channel, subject, from_address, user_id, first_message_at, last_message_at, created_at, updated_at) VALUES (?, 'email', ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, `About ${id}`, fromAddress, userId, T, T, T, T)
    .run();
  await env.DB.prepare(
    "INSERT INTO pithy_support_messages (id, thread_id, direction, channel, from_address, subject, text_body, raw_key, received_at, created_at) VALUES (?, ?, 'inbound', 'email', ?, ?, 'Hello.', ?, ?, ?)",
  )
    .bind(`m-${id}`, id, fromAddress, `About ${id}`, `raw/${id}`, T, T)
    .run();
  await env.DB.prepare(
    "INSERT INTO pithy_support_attachments (id, message_id, thread_id, filename, content_type, size, sha256, storage_key, created_at) VALUES (?, ?, ?, 'a.png', 'image/png', 3, 'abc', ?, ?)",
  )
    .bind(`a-${id}`, `m-${id}`, id, `att/${id}`, T)
    .run();
  await env.DB.prepare(
    "INSERT INTO pithy_support_thread_flags (id, thread_id, viewer, read, created_at, updated_at) VALUES (?, ?, 'operator', 1, ?, ?)",
  )
    .bind(`f-${id}`, id, T, T)
    .run();
  await env.DB.prepare(
    "INSERT INTO pithy_support_classifications (id, thread_id, message_id, category, priority, sentiment, confidence, model, created_at) VALUES (?, ?, ?, 'question', 'normal', 'neutral', 0.9, 'test-model', ?)",
  )
    .bind(`c-${id}`, id, `m-${id}`, T)
    .run();
  // Handed to a staff member and then to another: two rows of history, and the second is who has it now.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO pithy_support_assignments (id, thread_id, assignee_ref, assignee_name, previous_ref, previous_name, actor_type, assigned_by, note, created_at) VALUES (?, ?, 'grace', 'Grace', NULL, NULL, 'user', 'staff-1', 'Billing question.', ?)",
    ).bind(`h1-${id}`, id, T),
    env.DB.prepare(
      "INSERT INTO pithy_support_assignments (id, thread_id, assignee_ref, assignee_name, previous_ref, previous_name, actor_type, assigned_by, note, created_at) VALUES (?, ?, 'linus', 'Linus', 'grace', 'Grace', 'control-plane', 'cp-subject', NULL, ?)",
    ).bind(`h2-${id}`, id, T + 1),
    env.DB.prepare(
      "UPDATE pithy_support_threads SET assignee_ref = 'linus', assignee_name = 'Linus', assigned_at = ?, assigned_by = 'cp-subject' WHERE id = ?",
    ).bind(T + 1, id),
  ]);
  await env.SUPPORT_BUCKET.put(`raw/${id}`, "mime");
  await env.SUPPORT_BUCKET.put(`att/${id}`, "png");
}

beforeEach(async () => {
  for (const table of TABLES) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  for (const migration of Object.values(SUPPORT_MIGRATIONS)) {
    await migration.up(createDatabase(env.DB, {}) as unknown as Kysely<unknown>);
  }
  await thread("linked", "ada", "ada@example.test");
  await thread("before-signup", null, "ada@example.test");
  await thread("bobs", "bob", "bob@example.test");
});

describe("the support user purge", () => {
  test("support() declares it for the user subject, with a summary and an export", () => {
    const declared = support().purge ?? [];
    expect(declared.map((contribution) => contribution.subject)).toEqual(["user"]);
    expect(declared[0]?.summary).toBe(SUPPORT_PURGE_SUMMARY);
    expect(typeof declared[0]?.export).toBe("function");
  });

  test("exports the threads linked to the account and sent from its address, and no credential", async () => {
    const data = await exportOf(context("ada", " Ada@Example.test"));
    expect((data.threads as { id: string }[]).map((row) => row.id).sort()).toEqual(["before-signup", "linked"]);
    expect((data.messages as { id: string; textBody: string }[]).map((row) => row.id).sort()).toEqual([
      "m-before-signup",
      "m-linked",
    ]);
    expect((data.attachments as { filename: string }[]).map((row) => row.filename)).toEqual(["a.png", "a.png"]);
    expect(credentialFields(data)).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("bob");
  });

  test("exports who had each of their threads, oldest first, and never who made the change (#816)", async () => {
    const data = await exportOf(context("ada", "ada@example.test"));
    const history = data.assignments as Record<string, unknown>[];
    expect(history.map((row) => row.id)).toEqual(["h1-before-signup", "h1-linked", "h2-before-signup", "h2-linked"]);
    expect(history[0]).toMatchObject({
      threadId: "before-signup",
      assigneeRef: "grace",
      assigneeName: "Grace",
      note: "Billing question.",
    });
    expect(history[2]).toMatchObject({ assigneeRef: "linus", previousRef: "grace", previousName: "Grace" });
    const threads = data.threads as Record<string, unknown>[];
    expect(threads[0]).toMatchObject({ assigneeRef: "linus", assigneeName: "Linus" });
    // Who acted is the operator's, not the person's: the audit trail keeps the act with its actor.
    for (const row of [...history, ...threads]) expect(row).not.toHaveProperty("assignedBy");
    expect(JSON.stringify(data)).not.toContain("staff-1");
    expect(JSON.stringify(data)).not.toContain("cp-subject");
  });

  test("with no address to read, exports what is linked to the account", async () => {
    const data = await exportOf(context("ada", null));
    expect((data.threads as { id: string }[]).map((row) => row.id)).toEqual(["linked"]);
  });

  test("erases the threads, their rows and their bytes, and leaves everyone else's", async () => {
    await purge.erase(context("ada", "ada@example.test"));
    expect(await exportOf(context("ada", "ada@example.test"))).toEqual({
      threads: [],
      messages: [],
      attachments: [],
      assignments: [],
      handovers: [],
    });
    for (const key of ["raw/linked", "att/linked", "raw/before-signup", "att/before-signup"]) {
      expect(await env.SUPPORT_BUCKET.head(key)).toBeNull();
    }
    expect(await env.SUPPORT_BUCKET.head("att/bobs")).not.toBeNull();
    for (const table of TABLES) {
      const left = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
      // Bob's one thread is left, with its one row in each table — and its two handovers.
      expect(left?.n, table).toBe(table === "pithy_support_assignments" ? 2 : 1);
    }
    const history = await env.DB.prepare("SELECT thread_id FROM pithy_support_assignments").all<{
      thread_id: string;
    }>();
    expect(new Set(history.results.map((row) => row.thread_id))).toEqual(new Set(["bobs"]));
    const kept = await env.DB.prepare("SELECT id FROM pithy_support_classifications").all<{ id: string }>();
    expect(kept.results.map((row) => row.id)).toEqual(["c-bobs"]);
  });

  test("leaves a thread from their address that another account is linked to, in the export and the erase", async () => {
    // The address moved: whoever held it wrote in and was linked, then changed address, and it is Ada's now.
    await thread("someone-elses", "u-2", "ada@example.test");
    const data = await exportOf(context("ada", "ada@example.test"));
    expect((data.threads as { id: string }[]).map((row) => row.id).sort()).toEqual(["before-signup", "linked"]);
    expect(JSON.stringify(data)).not.toContain("someone-elses");
    await purge.erase(context("ada", "ada@example.test"));
    const left = await env.DB.prepare("SELECT id FROM pithy_support_threads ORDER BY id").all<{ id: string }>();
    expect(left.results.map((row) => row.id)).toEqual(["bobs", "someone-elses"]);
    const messages = await env.DB.prepare(
      "SELECT id FROM pithy_support_messages WHERE thread_id = 'someone-elses'",
    ).all();
    expect(messages.results).toHaveLength(1);
    const handovers = await env.DB.prepare(
      "SELECT id FROM pithy_support_assignments WHERE thread_id = 'someone-elses'",
    ).all();
    expect(handovers.results).toHaveLength(2);
    expect(await env.SUPPORT_BUCKET.head("raw/someone-elses")).not.toBeNull();
    expect(await env.SUPPORT_BUCKET.head("att/someone-elses")).not.toBeNull();
  });

  test("exports a person with more threads than D1 binds in one statement", async () => {
    const statements = Array.from({ length: 120 }, (_, n) =>
      env.DB.prepare(
        "INSERT INTO pithy_support_threads (id, channel, subject, from_address, user_id, first_message_at, last_message_at, created_at, updated_at) VALUES (?, 'email', 'Many', 'ada@example.test', 'ada', ?, ?, ?, ?)",
      ).bind(`many-${n}`, T, T, T + n + 1, T),
    );
    await env.DB.batch(statements);
    const data = await exportOf(context("ada", "ada@example.test"));
    expect((data.threads as unknown[]).length).toBe(122);
    expect((data.messages as unknown[]).length).toBe(2);
    expect((data.attachments as unknown[]).length).toBe(2);
  });

  test("erases a page of threads holding more objects than R2 deletes in one call", async () => {
    const statements = Array.from({ length: 501 }, (_, n) => [
      env.DB.prepare(
        "INSERT INTO pithy_support_messages (id, thread_id, direction, channel, from_address, subject, text_body, raw_key, received_at, created_at) VALUES (?, 'linked', 'inbound', 'email', 'ada@example.test', 'More', 'Hello.', ?, ?, ?)",
      ).bind(`more-${n}`, `raw/more-${n}`, T + n + 1, T),
      env.DB.prepare(
        "INSERT INTO pithy_support_attachments (id, message_id, thread_id, filename, content_type, size, sha256, storage_key, created_at) VALUES (?, ?, 'linked', 'b.png', 'image/png', 3, 'abc', ?, ?)",
      ).bind(`more-a-${n}`, `more-${n}`, `att/more-${n}`, T),
    ]);
    await env.DB.batch(statements.flat());
    await env.SUPPORT_BUCKET.put("raw/more-500", "mime");
    await purge.erase(context("ada", "ada@example.test"));
    expect(await exportOf(context("ada", "ada@example.test"))).toEqual({
      threads: [],
      messages: [],
      attachments: [],
      assignments: [],
      handovers: [],
    });
    expect(await env.SUPPORT_BUCKET.head("raw/more-500")).toBeNull();
    expect(await env.SUPPORT_BUCKET.head("att/bobs")).not.toBeNull();
  });

  test("exports the handovers a staff member made on other people's threads, without the customer's words", async () => {
    const data = await exportOf(context("staff-1", "staff@example.test"));
    expect(data.threads).toEqual([]);
    expect(data.handovers).toEqual([
      {
        id: "h1-before-signup",
        threadId: "before-signup",
        actorType: "user",
        assignedBy: "staff-1",
        createdAt: new Date(T).toISOString(),
      },
      {
        id: "h1-bobs",
        threadId: "bobs",
        actorType: "user",
        assignedBy: "staff-1",
        createdAt: new Date(T).toISOString(),
      },
      {
        id: "h1-linked",
        threadId: "linked",
        actorType: "user",
        assignedBy: "staff-1",
        createdAt: new Date(T).toISOString(),
      },
    ]);
    expect(JSON.stringify(data.handovers)).not.toContain("Billing question.");
  });

  test("a purged staff member's id leaves every handover they made and every thread they assigned, and nothing else", async () => {
    // Staff-1 made the current assignment on Bob's thread, as a signed-in user, and a client with the same id did on
    // Ada's: only the user's own act is theirs.
    await env.DB.prepare("UPDATE pithy_support_threads SET assigned_by = 'staff-1', assigned_at = ? WHERE id = 'bobs'")
      .bind(T)
      .run();
    await env.DB.prepare(
      "UPDATE pithy_support_threads SET assigned_by = 'staff-1', assigned_at = ? WHERE id = 'linked'",
    )
      .bind(T + 2)
      .run();
    await env.DB.prepare(
      "INSERT INTO pithy_support_assignments (id, thread_id, assignee_ref, assignee_name, previous_ref, previous_name, actor_type, assigned_by, note, created_at) VALUES ('cp-same', 'linked', 'grace', 'Grace', 'linus', 'Linus', 'control-plane', 'staff-1', NULL, ?)",
    )
      .bind(T + 2)
      .run();
    await purge.erase(context("staff-1", "staff@example.test"));
    const rows = await env.DB.prepare(
      "SELECT id, actor_type, assigned_by FROM pithy_support_assignments ORDER BY id",
    ).all<{ id: string; actor_type: string; assigned_by: string }>();
    for (const row of rows.results) {
      if (row.actor_type === "user") expect(row.assigned_by, row.id).toBe(ERASED_ASSIGNER);
    }
    expect(rows.results.find((row) => row.id === "cp-same")?.assigned_by).toBe("staff-1");
    expect(rows.results.find((row) => row.id === "h2-bobs")?.assigned_by).toBe("cp-subject");
    const threads = await env.DB.prepare("SELECT id, assigned_by FROM pithy_support_threads ORDER BY id").all<{
      id: string;
      assigned_by: string;
    }>();
    expect(threads.results).toEqual([
      { id: "before-signup", assigned_by: "cp-subject" },
      { id: "bobs", assigned_by: ERASED_ASSIGNER },
      { id: "linked", assigned_by: "staff-1" },
    ]);
    // Nobody's thread went with them, and the history stays whole.
    expect(rows.results).toHaveLength(7);
    expect((await exportOf(context("staff-1", "staff@example.test"))).handovers).toEqual([]);
    await expect(purge.erase(context("staff-1", "staff@example.test"))).resolves.toBeUndefined();
  });

  test("is idempotent: a second erase finds nothing and succeeds", async () => {
    await purge.erase(context("ada", "ada@example.test"));
    await expect(purge.erase(context("ada", "ada@example.test"))).resolves.toBeUndefined();
  });
});
