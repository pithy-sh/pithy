// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "./capability/capability";
import { createBackend } from "./createBackend";
import { SQLiteBoolean, SQLiteDate } from "./data/codecs";
import { createDatabase } from "./data/db";
import type { KvStoreSpec } from "./kv/namespaces";

// A capability that contributes tables to TWO databases (the `app` DB and a separate `analytics`
// DB, each its own binding) plus one KV namespace. createBackend should expose c.var.db.app and
// c.var.db.analytics as distinct typed Kysely instances, and c.var.kv.auth.sessions as a typed store.
const Widget = z
  .object({
    id: z.number().describe("Auto-incrementing PK."),
    name: z.string().describe("Widget name."),
    isActive: SQLiteBoolean.describe("Active flag (0|1 in D1)."),
    createdAt: SQLiteDate.describe("Created time (ms-epoch in D1)."),
  })
  .describe("A widget row (app database).");

const Event = z
  .object({
    id: z.number().describe("Auto-incrementing PK."),
    kind: z.string().describe("Event kind."),
    at: SQLiteDate.describe("Event time (ms-epoch in D1)."),
  })
  .describe("An analytics event row (analytics database).");

const Session = z
  .object({ userId: z.string().describe("Owner user id."), createdAt: z.number().describe("Created ms-epoch.") })
  .describe("A session value.");
const SessionKey = z.object({ sessionId: z.string().describe("Session id.") }).describe("Session key.");
// `satisfies` (not `: KvStoreSpec`) keeps the precise value/key types so the store stays typed.
const sessionStore = { prefix: "session", key: SessionKey, value: Session } satisfies KvStoreSpec;

const data = defineCapability({
  name: "data",
  requiredBindings: [],
  databases: {
    app: { binding: "DB", tables: { widgets: Widget } },
    analytics: { binding: "ANALYTICS", tables: { events: Event } },
  },
  kvNamespaces: { auth: { binding: "SESSIONS", stores: { sessions: sessionStore } } },
});

describe("createBackend — typed db registry", () => {
  beforeEach(async () => {
    const appDb = createDatabase(env.DB, { widgets: Widget });
    await appDb.schema.dropTable("widgets").ifExists().execute();
    await sql`
      create table widgets (
        id integer primary key autoincrement,
        name text not null,
        is_active integer not null,
        created_at integer not null
      )
    `.execute(appDb);

    const analyticsDb = createDatabase(env.ANALYTICS, { events: Event });
    await analyticsDb.schema.dropTable("events").ifExists().execute();
    await sql`
      create table events (id integer primary key autoincrement, kind text not null, at integer not null)
    `.execute(analyticsDb);
  });

  test("exposes one typed Kysely per database, each over its own schema and binding", async () => {
    const app = createBackend({ capabilities: [data] });
    const when = new Date(1_700_000_000_000);

    app.post("/seed", async (c) => {
      await c.var.db.app
        .insertInto("widgets")
        .values({ name: "w1", isActive: SQLiteBoolean.encode(true), createdAt: SQLiteDate.encode(when) })
        .execute();
      await c.var.db.analytics
        .insertInto("events")
        .values({ kind: "click", at: SQLiteDate.encode(when) })
        .execute();

      const widget = Widget.parse(await c.var.db.app.selectFrom("widgets").selectAll().executeTakeFirstOrThrow());
      const event = Event.parse(await c.var.db.analytics.selectFrom("events").selectAll().executeTakeFirstOrThrow());
      return c.json({ widget: widget.name, widgetActive: widget.isActive, event: event.kind });
    });

    const res = await app.request("/seed", { method: "POST" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ widget: "w1", widgetActive: true, event: "click" });
  });

  test("a missing D1 binding for a registered database fails fast", async () => {
    const app = createBackend({ capabilities: [data] });
    // Pass an env without ANALYTICS; the analytics database requires that binding.
    const res = await app.request("/health", {}, { DB: env.DB, SESSIONS: env.SESSIONS });
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/Missing required bindings: d1:ANALYTICS/);
  });

  test("a database's binding stays required even if the capability also marks it optional", async () => {
    // The database on ANALYTICS makes that binding structurally required; an author also listing it
    // as optional must not mask the fail-fast check.
    const stubborn = defineCapability({
      name: "stubborn",
      requiredBindings: [{ type: "d1", name: "ANALYTICS", optional: true }],
      databases: { metrics: { binding: "ANALYTICS", tables: { events: Event } } },
    });
    const app = createBackend({ capabilities: [stubborn] });
    const res = await app.request("/health", {}, { DB: env.DB, SESSIONS: env.SESSIONS });
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/Missing required bindings: d1:ANALYTICS/);
  });
});

describe("createBackend — typed kv", () => {
  test("c.var.kv exposes typed stores round-tripping against KV", async () => {
    const app = createBackend({ capabilities: [data] });

    app.post("/session", async (c) => {
      await c.var.kv.auth.sessions.put({ sessionId: "s1" }, { userId: "u1", createdAt: 7 });
      const stored = await c.var.kv.auth.sessions.get({ sessionId: "s1" });
      return c.json(stored);
    });

    const res = await app.request("/session", { method: "POST" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: "u1", createdAt: 7 });
  });

  test("the store's value schema validates on write", async () => {
    const app = createBackend({ capabilities: [data] });
    app.post("/bad", async (c) => {
      // @ts-expect-error userId must be a string — the store validates the value.
      await c.var.kv.auth.sessions.put({ sessionId: "s2" }, { userId: 1, createdAt: 7 });
      return c.text("unreachable");
    });
    const res = await app.request("/bad", { method: "POST" }, env);
    expect(res.status).toBe(500);
  });

  test("missing KV binding for a registered store fails fast", async () => {
    const cacheCap = defineCapability({
      name: "cacheCap",
      requiredBindings: [],
      kvNamespaces: {
        cms: {
          binding: "CACHE",
          stores: {
            pages: {
              prefix: "page",
              key: z.object({ slug: z.string().describe("Page slug.") }).describe("Page key."),
              value: z.object({ html: z.string().describe("Rendered HTML.") }).describe("A cached page."),
            },
          },
        },
      },
    });
    const app = createBackend({ capabilities: [cacheCap] });
    // env has DB + ANALYTICS + SESSIONS but no CACHE; the registered store requires it.
    const res = await app.request("/health", {}, { DB: env.DB, SESSIONS: env.SESSIONS });
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/Missing required bindings: kv:CACHE/);
  });
});

// Compile-time proofs: the merged databases/stores precisely type c.var.db and c.var.kv at the
// createBackend surface. Never executed — `tsc` checks the body, and each @ts-expect-error fails
// the build if its error disappears (i.e. if typing ever regresses to `unknown`).
function typeProofs(): void {
  const app = createBackend({ capabilities: [data] });
  app.get("/_proof", (c) => {
    c.var.db.app.selectFrom("widgets");
    c.var.db.analytics.selectFrom("events");
    // @ts-expect-error "not_a_table" is not in the app database.
    c.var.db.app.selectFrom("not_a_table");
    // @ts-expect-error "not_a_db" is not a registered database.
    c.var.db.not_a_db;
    c.var.kv.auth.sessions.get({ sessionId: "x" });
    // @ts-expect-error "not_a_store" is not a store in the auth namespace.
    c.var.kv.auth.not_a_store;
    // @ts-expect-error "not_a_namespace" is not a registered KV namespace.
    c.var.kv.not_a_namespace;
    return c.text("ok");
  });
}
void typeProofs;
