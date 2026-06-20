import { env } from "cloudflare:test";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { createBackend } from "@pithy-sh/core/src/createBackend";
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
});
