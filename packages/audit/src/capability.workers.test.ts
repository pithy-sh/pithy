// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import { createLogger } from "@pithy-sh/core/src/logger/logger";
import type { LogRecord } from "@pithy-sh/core/src/logger/record";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { audit } from "./capability";
import { auditDatabase } from "./data/tables";
import { audit_0001_init } from "./migrations/0001_init";
import { queryAuditEvents } from "./query";

beforeEach(async () => {
  await env.DB.prepare("drop table if exists pithy_audit_events").run();
  await audit_0001_init.up(auditDatabase(env.DB) as unknown as Kysely<unknown>);
});

describe("audit capability through createBackend", () => {
  test("its middleware replaces the no-op emit seam, so a route's c.var.emit persists a row", async () => {
    // A consumer capability that emits through the core seam — it never imports @pithy-sh/audit.
    const app = defineCapability({
      name: "app",
      requiredBindings: [],
      routes: (a) => {
        a.post("/login", async (c) => {
          await c.var.emit({
            action: "auth/login",
            outcome: "success",
            actorType: "user",
            actorId: "user-42",
            ip: "203.0.113.1",
          });
          return c.json({ ok: true });
        });
      },
    });

    const backend = createBackend({ capabilities: [audit()], app });
    const res = await backend.request("/login", { method: "POST" }, env);
    expect(res.status).toBe(200);

    const events = await queryAuditEvents(auditDatabase(env.DB), { actorId: "user-42" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "auth/login", outcome: "success", actorType: "user", ip: "203.0.113.1" });
  });

  test("the middleware stamps the origin from the Worker's own vars, through the real composition", async () => {
    // The whole read path, unstubbed: `createBackend` → the audit middleware → `workerIdentity(c.env)` →
    // the recorder → the row. Every other origin test injects an `AuditOrigin` directly, which proves the
    // recorder writes what it is given but not that anything ever gives it the right thing.
    const app = defineCapability({
      name: "app",
      requiredBindings: [],
      routes: (a) => {
        a.post("/act", async (c) => {
          await c.var.emit({ action: "admin/config_changed", outcome: "success", actorType: "user", actorId: "u-org" });
          return c.json({ ok: true });
        });
      },
    });

    const backend = createBackend({ capabilities: [audit()], app });
    const res = await backend.request(
      "/act",
      { method: "POST" },
      { ...env, PROJECT: "acme", ENVIRONMENT: "prod", WORKER: "api" },
    );
    expect(res.status).toBe(200);

    const [event] = await queryAuditEvents(auditDatabase(env.DB), { actorId: "u-org" });
    expect(event).toMatchObject({ project: "acme", environment: "prod", worker: "api" });
  });

  test("a Worker carrying none of the vars still records, with a null origin", async () => {
    // The unstamped Worker. A missing var must cost the origin, never the event — the recorder is
    // contractually non-fatal, and a dropped audit row is the strictly worse outcome.
    const app = defineCapability({
      name: "app",
      requiredBindings: [],
      routes: (a) => {
        a.post("/act", async (c) => {
          await c.var.emit({
            action: "admin/config_changed",
            outcome: "success",
            actorType: "user",
            actorId: "u-bare",
          });
          return c.json({ ok: true });
        });
      },
    });

    const backend = createBackend({ capabilities: [audit()], app });
    expect((await backend.request("/act", { method: "POST" }, env)).status).toBe(200);

    const [event] = await queryAuditEvents(auditDatabase(env.DB), { actorId: "u-bare" });
    expect(event).toMatchObject({ project: null, environment: null, worker: null });
  });

  test("an emitting route cannot forge an origin through the seam", async () => {
    // The security claim at the surface a real attacker would reach: a route handler, not the recorder.
    const app = defineCapability({
      name: "app",
      requiredBindings: [],
      routes: (a) => {
        a.post("/act", async (c) => {
          await c.var.emit({
            action: "admin/config_changed",
            outcome: "success",
            actorType: "user",
            actorId: "u-forge",
            project: "victim",
            environment: "prod",
            worker: "admin",
          } as never);
          return c.json({ ok: true });
        });
      },
    });

    const backend = createBackend({ capabilities: [audit()], app });
    await backend.request("/act", { method: "POST" }, { ...env, PROJECT: "acme", ENVIRONMENT: "dev", WORKER: "api" });

    const [event] = await queryAuditEvents(auditDatabase(env.DB), { actorId: "u-forge" });
    expect(event).toMatchObject({ project: "acme", environment: "dev", worker: "api" });
  });

  test("a non-fatal write failure routes through the logger seam (not console) as an audit/* record", async () => {
    // Drop the table so the insert fails; the recorder must stay non-fatal and log through c.var.log.
    await env.DB.prepare("drop table pithy_audit_events").run();
    const records: LogRecord[] = [];
    const logger = createLogger({ level: "debug", sink: (r) => records.push(r) });

    const app = defineCapability({
      name: "app",
      requiredBindings: [],
      routes: (a) => {
        a.post("/login", async (c) => {
          await c.var.emit({ action: "auth/login", outcome: "success", actorType: "system" });
          return c.json({ ok: true });
        });
      },
    });

    const backend = createBackend({ capabilities: [audit()], app, logger });
    // The audited action still succeeds — the drop is non-fatal.
    expect((await backend.request("/login", { method: "POST" }, env)).status).toBe(200);

    const dropped = records.find((r) => r.name === "audit" && r.msg === "audit event dropped");
    expect(dropped?.error).toMatchObject({ code: "audit/write_failed" });
    // The full internal detail rides on the log record — the inverse of the HTTP codec.
    expect(dropped?.error?.detail).toBeTruthy();
  });
});
