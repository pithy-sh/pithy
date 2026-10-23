// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import { NotFoundError } from "@pithy-sh/core/src/error/pithyError";
import { createMigrationRegistry } from "@pithy-sh/core/src/migrations/registry";
import { runMigrations } from "@pithy-sh/core/src/migrations/runner";
import { email } from "@pithy-sh/email/src/capability";
import { email_0001_init } from "@pithy-sh/email/src/migrations/0001_init";
import { beforeEach, describe, expect, test } from "vitest";
import { AuthConfig } from "../capability";
import { authDatabase } from "../data/tables";
import { UserLifecycleEvent } from "../data/userLifecycle";
import { AUTH_MIGRATION_ORDER } from "../migrations/0001_init";
import { AUTH_MIGRATIONS } from "../migrations/set";
import { readLifecycleColumns, suspensionReason } from "./enforce";
import type { UserLifecycleHookEvent, UserLifecycleHooks } from "./hooks";
import {
  completePurge,
  deleteUser,
  type LifecycleDeps,
  recordPurgeStep,
  reinstateUser,
  restoreUser,
  suspendUser,
} from "./transitions";

/**
 * The transitions every lifecycle action is built on (#620). The admin routes (#621, #622) and the purge
 * Workflow call these and nothing else, so what is proved here — the columns and the row written together,
 * the audit event, the mail, a hook fired once and only once, a throwing hook that changes nothing — holds
 * for every one of them.
 */

const TABLES = [
  "pithy_auth_accounts",
  "pithy_auth_devices",
  "pithy_auth_jwks",
  "pithy_auth_rate_limit",
  "pithy_auth_rotated_tokens",
  "pithy_auth_sessions",
  "pithy_auth_user_lifecycle",
  "pithy_auth_users",
  "pithy_auth_verifications",
  "pithy_email_jobs",
  "pithy_email_events",
];

const NOW = new Date("2026-10-20T12:00:00.000Z");
const DAY = 86_400_000;
const OPERATOR = { type: "control-plane", id: "connection-1" } as const;

/** Everything a test reads back after a transition. */
interface Harness {
  deps: LifecycleDeps;
  events: AuditEventInput[];
  fired: { hook: keyof UserLifecycleHooks; event: UserLifecycleHookEvent }[];
  warnings: string[];
}

function harness(
  options: { config?: Parameters<typeof AuthConfig.parse>[0]; hooks?: UserLifecycleHooks; throwing?: boolean } = {},
): Harness {
  const events: AuditEventInput[] = [];
  const fired: Harness["fired"] = [];
  const warnings: string[] = [];
  const record =
    (hook: keyof UserLifecycleHooks) =>
    (event: UserLifecycleHookEvent): void => {
      fired.push({ hook, event });
      if (options.throwing) throw new Error(`the adopter's ${hook} broke`);
    };
  const emailCap = email({ fromAddress: "no@reply.test", fromName: "Acme", baseUrl: "http://localhost" });
  const config = AuthConfig.parse({ baseURL: "http://localhost", ...(options.config ?? {}) });
  const log = {
    debug: () => {},
    info: () => {},
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => {},
    child() {
      return log;
    },
  };
  return {
    events,
    fired,
    warnings,
    deps: {
      db: authDatabase(env.DB),
      d1: env.DB,
      emit: async (event) => {
        events.push(event);
      },
      config,
      hooks: options.hooks ?? {
        onUserSuspended: record("onUserSuspended"),
        onUserReinstated: record("onUserReinstated"),
        onUserDeleted: record("onUserDeleted"),
        onUserPurged: record("onUserPurged"),
      },
      enqueueEmail: (input) => emailCap.enqueue(env, input),
      log,
      now: () => NOW,
    },
  };
}

async function seedUser(id = "u1", locale: string | null = null): Promise<void> {
  await env.DB.prepare(
    "insert into pithy_auth_users (id, name, email, email_verified, locale, created_at, updated_at) values (?, 'Sam', ?, 1, ?, ?, ?)",
  )
    .bind(id, `${id}@test.com`, locale, NOW.toISOString(), NOW.toISOString())
    .run();
}

async function history(userId = "u1"): Promise<UserLifecycleEvent[]> {
  const rows = await authDatabase(env.DB)
    .selectFrom("pithyAuthUserLifecycle")
    .selectAll()
    .where("userId", "=", userId)
    .orderBy("id")
    .execute();
  return rows.map((row) => UserLifecycleEvent.parse(row));
}

async function jobs(): Promise<
  { template: string; to: string; payload: Record<string, unknown>; locale: string | null }[]
> {
  const rows = await env.DB.prepare(
    "select template, to_address, payload, locale from pithy_email_jobs order by rowid",
  ).all<{ template: string; to_address: string; payload: string; locale: string | null }>();
  return rows.results.map((row) => ({
    template: row.template,
    to: row.to_address,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    locale: row.locale,
  }));
}

beforeEach(async () => {
  for (const table of [...TABLES, "pithy_migrations", "pithy_migrations_lock"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  const provider = createMigrationRegistry([
    { database: "app", namespace: "auth", order: AUTH_MIGRATION_ORDER, migrations: AUTH_MIGRATIONS },
    { database: "app", namespace: "email", order: 200, migrations: { "0001_init": email_0001_init } },
  ]).app;
  if (!provider) throw new Error('expected a provider for database "app"');
  await runMigrations(env.DB, provider);
});

describe("suspendUser", () => {
  test("writes the columns and the row together, emits the audit event, mails, and fires the hook once", async () => {
    await seedUser();
    const h = harness();
    const until = new Date(NOW.getTime() + 7 * DAY);
    const result = await suspendUser(h.deps, {
      userId: "u1",
      actor: OPERATOR,
      reason: "A payment is under review.",
      until,
    });
    expect(result.changed).toBe(true);

    const columns = await readLifecycleColumns(h.deps.db, "u1");
    expect(columns?.suspendedAt?.getTime()).toBe(NOW.getTime());
    expect(columns?.suspendedUntil?.getTime()).toBe(until.getTime());

    const [row] = await history();
    expect(row).toMatchObject({
      action: "suspended",
      actorType: "control-plane",
      actorId: "connection-1",
      reason: "A payment is under review.",
    });
    expect(row?.suspendedUntil?.getTime()).toBe(until.getTime());

    expect(h.events).toEqual([
      expect.objectContaining({
        action: "auth/admin_user_suspended",
        outcome: "success",
        actorType: "control-plane",
        actorId: "connection-1",
        resourceType: "user",
        resourceId: "u1",
      }),
    ]);

    const [job] = await jobs();
    expect(job).toMatchObject({ template: "accountSuspended", to: "u1@test.com" });
    expect(job?.payload).toEqual({ name: "Sam", reason: "A payment is under review.", until: "October 27, 2026" });

    expect(h.fired.map((call) => call.hook)).toEqual(["onUserSuspended"]);
    expect(h.fired[0]?.event).toMatchObject({ userId: "u1", reason: "A payment is under review." });
  });

  test("suspending an account that is already suspended restates the reason and the end (#621)", async () => {
    await seedUser();
    const h = harness();
    const first = await suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "First." });
    expect(first).toMatchObject({ changed: true, updated: false, mailed: true, suspendedUntil: null });
    expect(first.suspendedAt.getTime()).toBe(NOW.getTime());

    const until = new Date(NOW.getTime() + 3 * DAY);
    const again = await suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Second.", until });
    // Not a transition — the account was suspended and still is — but its terms moved, and the call says so.
    expect(again).toMatchObject({ changed: false, updated: true, mailed: true });
    expect(again.suspendedAt.getTime()).toBe(NOW.getTime());
    expect(again.suspendedUntil?.getTime()).toBe(until.getTime());

    const columns = await readLifecycleColumns(h.deps.db, "u1");
    expect(columns?.suspendedAt?.getTime()).toBe(NOW.getTime());
    expect(columns?.suspendedUntil?.getTime()).toBe(until.getTime());
    // A row for the restatement, so the reason the person is shown is the newest one.
    const rows = await history();
    expect(rows.map((row) => [row.action, row.reason])).toEqual([
      ["suspended", "First."],
      ["suspended", "Second."],
    ]);
    expect(rows[1]?.suspendedUntil?.getTime()).toBe(until.getTime());
    expect(await suspensionReason(h.deps.db, "u1")).toBe("Second.");
    // The person is told the new terms; the hook hears transitions only, so it fired once.
    expect((await jobs()).map((job) => job.payload.reason)).toEqual(["First.", "Second."]);
    expect(h.fired).toHaveLength(1);
    expect(h.events.map((event) => event.metadata)).toEqual([
      expect.objectContaining({ updated: false, reason: "First." }),
      expect.objectContaining({ updated: true, reason: "Second.", suspendedUntil: until.toISOString() }),
    ]);
  });

  test("a restatement that loses the race to a reinstatement is a conflict, and writes nothing", async () => {
    await seedUser();
    const h = harness();
    await suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "First." });
    const d1 = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch") {
          return async (statements: Parameters<typeof target.batch>[0]) => {
            await target.prepare("update pithy_auth_users set suspended_at = null, suspended_until = null").run();
            return await target.batch(statements);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      suspendUser({ ...h.deps, d1 }, { userId: "u1", actor: OPERATOR, reason: "Second." }),
    ).rejects.toMatchObject({ payload: { code: "core/conflict" } });
    expect((await history()).map((row) => row.reason)).toEqual(["First."]);
    expect(h.events).toHaveLength(1);
  });

  /** A D1 whose first batch lets `before` land first — another request's write, racing this one. */
  function racing(before: () => Promise<unknown>): D1Database {
    let raced = false;
    return new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch") {
          return async (statements: Parameters<typeof target.batch>[0]) => {
            if (!raced) {
              raced = true;
              await before();
            }
            return await target.batch(statements);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  test("a fresh suspension that loses the race to another suspension restates its terms instead of failing", async () => {
    await seedUser();
    const h = harness();
    const until = new Date(NOW.getTime() + 3 * DAY);
    const d1 = racing(() => suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "First." }));
    const result = await suspendUser({ ...h.deps, d1 }, { userId: "u1", actor: OPERATOR, reason: "Second.", until });
    expect(result).toMatchObject({ changed: false, updated: true, mailed: true });
    expect(result.suspendedAt.getTime()).toBe(NOW.getTime());
    expect(result.suspendedUntil?.getTime()).toBe(until.getTime());
    const columns = await readLifecycleColumns(h.deps.db, "u1");
    expect(columns?.suspendedUntil?.getTime()).toBe(until.getTime());
    expect((await history()).map((row) => row.reason)).toEqual(["First.", "Second."]);
    expect(await suspensionReason(h.deps.db, "u1")).toBe("Second.");
    // The suspension that landed first is the transition; this one only restated it.
    expect(h.fired).toHaveLength(1);
    expect(h.events.map((event) => event.metadata)).toEqual([
      expect.objectContaining({ updated: false, reason: "First." }),
      expect.objectContaining({ updated: true, reason: "Second.", suspendedUntil: until.toISOString() }),
    ]);
  });

  test("a fresh suspension that loses the race to a deletion is a conflict, and writes nothing", async () => {
    await seedUser();
    const h = harness();
    const d1 = racing(() => deleteUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Gone." }));
    await expect(
      suspendUser({ ...h.deps, d1 }, { userId: "u1", actor: OPERATOR, reason: "Review." }),
    ).rejects.toMatchObject({ payload: { code: "core/conflict" } });
    expect((await history()).map((row) => row.action)).toEqual(["deleted"]);
    expect(h.fired.map((entry) => entry.hook)).toEqual(["onUserDeleted"]);
  });

  test("notify: false sends no mail, and says so", async () => {
    await seedUser();
    const h = harness();
    const result = await suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Review.", notify: false });
    expect(result).toMatchObject({ changed: true, mailed: false });
    expect(await jobs()).toEqual([]);
    expect(h.fired).toHaveLength(1);
  });

  test("with no email capability composed nothing is mailed, and the result does not claim otherwise", async () => {
    await seedUser();
    const h = harness();
    const result = await suspendUser(
      { ...h.deps, enqueueEmail: undefined },
      { userId: "u1", actor: OPERATOR, reason: "x" },
    );
    expect(result.mailed).toBe(false);
  });

  test("the request's correlation and metadata ride on the audit event", async () => {
    await seedUser();
    const h = harness();
    await suspendUser(
      {
        ...h.deps,
        context: { ip: "203.0.113.7", userAgent: "Ops/1", requestId: "ray-1", metadata: { connectionId: "c-1" } },
      },
      { userId: "u1", actor: OPERATOR, reason: "Review." },
    );
    expect(h.events[0]).toMatchObject({
      ip: "203.0.113.7",
      userAgent: "Ops/1",
      requestId: "ray-1",
      metadata: { connectionId: "c-1", reason: "Review." },
    });
  });

  test("a deleted account's conflict names the route that restores it, when the caller gives one", async () => {
    await seedUser();
    const h = harness();
    await deleteUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "x" });
    const restoreRoute = "POST /auth/admin/users/u1/restore";
    for (const run of [
      () => suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "y", restoreRoute }),
      () => reinstateUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "y", restoreRoute }),
    ]) {
      const refusal = await run().then(
        () => null,
        (error: unknown) => error as { payload: { code: string; message: string; action?: string } },
      );
      expect(refusal?.payload.code).toBe("core/conflict");
      expect(refusal?.payload.message).toContain(restoreRoute);
      expect(refusal?.payload.action).toContain(restoreRoute);
    }
  });

  test("a suspension whose end has passed can be replaced by a new one", async () => {
    await seedUser();
    const h = harness();
    // A suspension that ran out an hour ago, written as the columns stand once its end has passed.
    await env.DB.prepare("update pithy_auth_users set suspended_at = ?, suspended_until = ? where id = 'u1'")
      .bind(NOW.getTime() - 2 * 3_600_000, NOW.getTime() - 3_600_000)
      .run();
    const again = await suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Longer." });
    expect(again.changed).toBe(true);
    expect((await readLifecycleColumns(h.deps.db, "u1"))?.suspendedUntil ?? null).toBeNull();
  });

  test("a hook that throws does not fail the transition, and is logged rather than lost", async () => {
    await seedUser();
    const h = harness({ throwing: true });
    const result = await suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Review." });
    expect(result.changed).toBe(true);
    expect((await readLifecycleColumns(h.deps.db, "u1"))?.suspendedAt).toBeInstanceOf(Date);
    expect(await history()).toHaveLength(1);
    expect(h.fired).toHaveLength(1);
    expect(h.warnings.some((message) => message.includes("onUserSuspended"))).toBe(true);
  });

  test("the mail is not sent when the config switches it off", async () => {
    await seedUser();
    const h = harness({ config: { lifecycleEmails: { accountSuspended: false } } });
    await suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Review." });
    expect(await jobs()).toEqual([]);
    expect(h.fired).toHaveLength(1);
  });

  test("the mail is written in the account's own language, dates included", async () => {
    await seedUser("u1", "es");
    const h = harness();
    await suspendUser(h.deps, {
      userId: "u1",
      actor: OPERATOR,
      reason: "Revisión.",
      until: new Date(NOW.getTime() + 7 * DAY),
    });
    const [job] = await jobs();
    expect(job?.locale).toBe("es");
    expect(job?.payload.until).toBe("27 de octubre de 2026");
  });

  test("an end in the past is refused — that would be a suspension that never held", async () => {
    await seedUser();
    const h = harness();
    await expect(
      suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "x", until: new Date(NOW.getTime() - 1) }),
    ).rejects.toMatchObject({ payload: { code: "validation/invalid_input" } });
    expect(await history()).toEqual([]);
  });

  test("suspending a deleted account is a conflict, because deletion already shuts it", async () => {
    await seedUser();
    const h = harness();
    await deleteUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "x" });
    await expect(suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "y" })).rejects.toMatchObject({
      payload: { code: "core/conflict" },
    });
  });

  test("an account that does not exist is a 404, and nothing is written", async () => {
    const h = harness();
    await expect(suspendUser(h.deps, { userId: "nobody", actor: OPERATOR, reason: "x" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await history("nobody")).toEqual([]);
    expect(h.fired).toEqual([]);
  });
});

describe("reinstateUser", () => {
  test("clears the suspension, records it, mails, and fires onUserReinstated once", async () => {
    await seedUser();
    const h = harness();
    await suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Review." });
    const result = await reinstateUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Cleared." });
    expect(result.changed).toBe(true);
    const columns = await readLifecycleColumns(h.deps.db, "u1");
    expect(columns?.suspendedAt ?? null).toBeNull();
    expect(columns?.suspendedUntil ?? null).toBeNull();
    expect((await history()).map((row) => row.action)).toEqual(["suspended", "reinstated"]);
    expect((await jobs()).map((job) => job.template)).toEqual(["accountSuspended", "accountReinstated"]);
    expect(h.fired.map((call) => call.hook)).toEqual(["onUserSuspended", "onUserReinstated"]);
    expect(h.events.map((event) => event.action)).toEqual(["auth/admin_user_suspended", "auth/admin_user_reinstated"]);
  });

  test("reinstating with notify: false sends no mail, and says so; the default says it did", async () => {
    await seedUser();
    const h = harness();
    await suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Review.", notify: false });
    const quiet = await reinstateUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Cleared.", notify: false });
    expect(quiet).toEqual({ changed: true, mailed: false });
    expect(await jobs()).toEqual([]);

    await suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Again.", notify: false });
    const loud = await reinstateUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Cleared." });
    expect(loud).toEqual({ changed: true, mailed: true });
    expect((await jobs()).map((job) => job.template)).toEqual(["accountReinstated"]);
  });

  test("reinstating an account that is not suspended is no transition", async () => {
    await seedUser();
    const h = harness();
    expect((await reinstateUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "x" })).changed).toBe(false);
    expect(h.fired).toEqual([]);
    expect(await history()).toEqual([]);
  });

  test("reinstating a suspension that has already run out is no transition: no row, no mail, no hook", async () => {
    await seedUser();
    const h = harness();
    // The columns as they stand an hour after a timed suspension ended. No write expires it, so they stay set.
    await env.DB.prepare("update pithy_auth_users set suspended_at = ?, suspended_until = ? where id = 'u1'")
      .bind(NOW.getTime() - 2 * 3_600_000, NOW.getTime() - 3_600_000)
      .run();
    expect((await reinstateUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "x" })).changed).toBe(false);
    expect(await history()).toEqual([]);
    expect(await jobs()).toEqual([]);
    expect(h.fired).toEqual([]);
    expect(h.events).toEqual([]);
  });

  test("reinstating a deleted account is a conflict, and tells nobody they can sign in again", async () => {
    await seedUser();
    const h = harness();
    await suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Review." });
    await deleteUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "x" });
    await expect(reinstateUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "y" })).rejects.toMatchObject({
      payload: { code: "core/conflict" },
    });
    expect((await readLifecycleColumns(h.deps.db, "u1"))?.suspendedAt).toBeInstanceOf(Date);
    expect((await history()).map((row) => row.action)).toEqual(["suspended", "deleted"]);
    expect((await jobs()).map((job) => job.template)).toEqual(["accountSuspended", "deletionScheduled"]);
    expect(h.fired.map((call) => call.hook)).toEqual(["onUserSuspended", "onUserDeleted"]);
  });
});

describe("the columns and the row are one write", () => {
  /** Make every insert into the history table fail, the way a D1 error between the two statements would. */
  async function breakHistory(): Promise<void> {
    await env.DB.prepare(
      "create trigger pithy_test_history_fails before insert on pithy_auth_user_lifecycle begin select raise(abort, 'history write failed'); end",
    ).run();
  }
  async function mendHistory(): Promise<void> {
    await env.DB.prepare("drop trigger pithy_test_history_fails").run();
  }

  const cases = [
    {
      name: "suspendUser",
      action: "suspended",
      before: async () => {},
      run: (deps: LifecycleDeps) => suspendUser(deps, { userId: "u1", actor: OPERATOR, reason: "Review." }),
      moved: (columns: Awaited<ReturnType<typeof readLifecycleColumns>>) => columns?.suspendedAt instanceof Date,
    },
    {
      name: "reinstateUser",
      action: "reinstated",
      before: async (deps: LifecycleDeps) => {
        await suspendUser(deps, { userId: "u1", actor: OPERATOR, reason: "Review." });
      },
      run: (deps: LifecycleDeps) => reinstateUser(deps, { userId: "u1", actor: OPERATOR, reason: "Cleared." }),
      moved: (columns: Awaited<ReturnType<typeof readLifecycleColumns>>) => (columns?.suspendedAt ?? null) === null,
    },
    {
      name: "deleteUser",
      action: "deleted",
      before: async () => {},
      run: (deps: LifecycleDeps) => deleteUser(deps, { userId: "u1", actor: OPERATOR, reason: "x" }),
      moved: (columns: Awaited<ReturnType<typeof readLifecycleColumns>>) => columns?.deletedAt instanceof Date,
    },
    {
      name: "restoreUser",
      action: "restored",
      before: async (deps: LifecycleDeps) => {
        await deleteUser(deps, { userId: "u1", actor: OPERATOR, reason: "x" });
      },
      run: (deps: LifecycleDeps) => restoreUser(deps, { userId: "u1", actor: OPERATOR, reason: "y" }),
      moved: (columns: Awaited<ReturnType<typeof readLifecycleColumns>>) => (columns?.deletedAt ?? null) === null,
    },
  ] as const;

  for (const each of cases) {
    test(`${each.name}: a failed history write leaves the account where it was, so a retry does the whole transition`, async () => {
      await seedUser();
      const h = harness();
      await each.before(h.deps);
      const firedBefore = h.fired.length;
      const eventsBefore = h.events.length;

      await breakHistory();
      await expect(each.run(h.deps)).rejects.toThrow();
      expect(each.moved(await readLifecycleColumns(h.deps.db, "u1"))).toBe(false);
      expect(h.fired).toHaveLength(firedBefore);
      expect(h.events).toHaveLength(eventsBefore);

      await mendHistory();
      expect((await each.run(h.deps)).changed).toBe(true);
      expect(each.moved(await readLifecycleColumns(h.deps.db, "u1"))).toBe(true);
      expect((await history()).filter((row) => row.action === each.action)).toHaveLength(1);
      expect(h.events).toHaveLength(eventsBefore + 1);
    });
  }

  test("an update that loses the race writes no history row either", async () => {
    await seedUser();
    const h = harness();
    await suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Review." });
    // Another request lifts the suspension after this one read the account and before its write lands.
    const d1 = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch") {
          return async (statements: Parameters<typeof target.batch>[0]) => {
            await target.prepare("update pithy_auth_users set suspended_at = null, suspended_until = null").run();
            return await target.batch(statements);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await reinstateUser({ ...h.deps, d1 }, { userId: "u1", actor: OPERATOR, reason: "Cleared." });
    expect(result.changed).toBe(false);
    expect((await history()).map((row) => row.action)).toEqual(["suspended"]);
    expect((await jobs()).map((job) => job.template)).toEqual(["accountSuspended"]);
    expect(h.fired.map((call) => call.hook)).toEqual(["onUserSuspended"]);
  });
});

describe("deleteUser", () => {
  test("stamps deletedAt and purgeAfter from the retention window, mails the purge date, fires onUserDeleted", async () => {
    await seedUser();
    const h = harness();
    const result = await deleteUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Asked by email." });
    expect(result.changed).toBe(true);
    const columns = await readLifecycleColumns(h.deps.db, "u1");
    expect(columns?.deletedAt?.getTime()).toBe(NOW.getTime());
    expect(columns?.purgeAfter?.getTime()).toBe(NOW.getTime() + 30 * DAY);
    const [job] = await jobs();
    expect(job).toMatchObject({
      template: "deletionScheduled",
      payload: { name: "Sam", purgeOn: "November 19, 2026" },
    });
    expect(h.fired.map((call) => call.hook)).toEqual(["onUserDeleted"]);
    expect(h.fired[0]?.event.purgeAfter?.getTime()).toBe(NOW.getTime() + 30 * DAY);
    expect(h.events[0]?.action).toBe("auth/admin_user_soft_deleted");
  });

  test("the window is the configured one", async () => {
    await seedUser();
    const h = harness({ config: { retention: { purgeAfterDays: 7 } } });
    await deleteUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "x" });
    expect((await readLifecycleColumns(h.deps.db, "u1"))?.purgeAfter?.getTime()).toBe(NOW.getTime() + 7 * DAY);
  });

  test("the account's own holder deleting it is audited as user_self_deleted, with them as the actor", async () => {
    await seedUser();
    const h = harness();
    await deleteUser(h.deps, { userId: "u1", actor: { type: "user", id: "u1" }, reason: null });
    expect(h.events[0]).toMatchObject({ action: "auth/user_self_deleted", actorType: "user", actorId: "u1" });
    expect((await history())[0]).toMatchObject({ action: "deleted", actorType: "user", actorId: "u1", reason: null });
  });

  test("deleting a deleted account is no transition", async () => {
    await seedUser();
    const h = harness();
    await deleteUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "x" });
    expect((await deleteUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "x" })).changed).toBe(false);
    expect(h.fired).toHaveLength(1);
  });
});

describe("restoreUser", () => {
  test("clears both deletion columns inside the window and records it", async () => {
    await seedUser();
    const h = harness();
    await deleteUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "x" });
    expect((await restoreUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Changed their mind." })).changed).toBe(
      true,
    );
    const columns = await readLifecycleColumns(h.deps.db, "u1");
    expect(columns?.deletedAt ?? null).toBeNull();
    expect(columns?.purgeAfter ?? null).toBeNull();
    expect((await history()).map((row) => row.action)).toEqual(["deleted", "restored"]);
    expect(h.events.map((event) => event.action)).toEqual(["auth/admin_user_soft_deleted", "auth/admin_user_restored"]);
  });

  test("restoring a deleted account that was suspended leaves it suspended", async () => {
    await seedUser();
    const h = harness();
    await suspendUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "Review." });
    await deleteUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "x" });
    await restoreUser(h.deps, { userId: "u1", actor: OPERATOR, reason: "y" });
    expect((await readLifecycleColumns(h.deps.db, "u1"))?.suspendedAt).toBeInstanceOf(Date);
  });

  test("after the purge there is nothing to restore, and it says so with a 404", async () => {
    const h = harness();
    await expect(restoreUser(h.deps, { userId: "gone", actor: OPERATOR, reason: "x" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("the purge's records", () => {
  test("recordPurgeStep writes one row naming the capability whose rows went", async () => {
    const h = harness();
    await recordPurgeStep(h.deps, { userId: "u1", step: "media" });
    expect((await history())[0]).toMatchObject({ action: "purge_step", actorType: "system", step: "media" });
  });

  test("completePurge mails the address it is handed, records, audits as system, and fires onUserPurged", async () => {
    // The purge Workflow (#622) captures the address before its steps erase it and hands it here, so the
    // last mail reaches somebody even though the user row is already gone.
    const h = harness();
    const result = await completePurge(h.deps, {
      userId: "u1",
      recipient: { email: "u1@test.com", name: "Sam", locale: null },
    });
    expect(result.changed).toBe(true);
    const [job] = await jobs();
    expect(job).toMatchObject({
      template: "deletionComplete",
      to: "u1@test.com",
      payload: { purgedOn: "October 20, 2026" },
    });
    expect((await history())[0]).toMatchObject({ action: "purged", actorType: "system" });
    expect(h.events[0]).toMatchObject({ action: "auth/admin_user_purged", actorType: "system" });
    expect(h.fired.map((call) => call.hook)).toEqual(["onUserPurged"]);
  });

  test("completing a purge twice records it, mails and fires once", async () => {
    const h = harness();
    const recipient = { email: "u1@test.com", name: "Sam", locale: null };
    await completePurge(h.deps, { userId: "u1", recipient });
    expect((await completePurge(h.deps, { userId: "u1", recipient })).changed).toBe(false);
    expect(await jobs()).toHaveLength(1);
    expect(h.fired).toHaveLength(1);
  });
});
