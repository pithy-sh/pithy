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
