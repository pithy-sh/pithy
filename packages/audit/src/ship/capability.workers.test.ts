// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { env } from "cloudflare:test";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { createBackend } from "@pithy-sh/core/src/createBackend";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { audit } from "../capability";
import { auditDatabase } from "../data/tables";
import { audit_0001_init } from "../migrations/0001_init";
import { audit_0002_actor_kind } from "../migrations/0002_actor_kind";
import { audit_0003_call_index } from "../migrations/0003_call_index";
import { audit_0004_request_index } from "../migrations/0004_request_index";
import { audit_0005_chain } from "../migrations/0005_chain";
import { queryAuditEvents } from "../query";
import { AUDIT_SHIP_BINDING, AUDIT_SHIP_DLQ_BINDING, AUDIT_SHIP_MAX_RETRIES } from "./queue";

/** Shipping through the composed capability (#824): declared in config, enqueued on every write, never in its way. */

beforeEach(async () => {
  await env.DB.prepare("drop table if exists pithy_audit_events").run();
  for (const migration of [
    audit_0001_init,
    audit_0002_actor_kind,
    audit_0003_call_index,
    audit_0004_request_index,
    audit_0005_chain,
  ]) {
    await migration.up(auditDatabase(env.DB) as unknown as Kysely<unknown>);
  }
});

const SINKS = {
  everything: { profile: "webhook", url: "https://hooks.example.com/audit", secret: "hook-token" },
  auth: {
    profile: "splunk-hec",
    url: "https://splunk.example.com/services/collector",
    secret: "hec",
    actions: ["auth/"],
  },
} as const;

/** `@pithy-sh/secrets` stands behind the token read; the composition only needs it present. */
const secretsStandIn = defineCapability({ name: "secrets", requiredBindings: [] });

function emitting(action: string, actorId: string) {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    routes: (a) => {
      a.post("/act", async (c) => {
        await c.var.emit({ action, outcome: "success", actorType: "user", actorId, ip: "203.0.113.4" });
        return c.json({ ok: true });
      });
    },
  });
}

describe("audit({ sinks })", () => {
  test("ships nothing and binds no queue when no sink is declared", () => {
    const capability = audit();
    expect(capability.requiredBindings.some((binding) => binding.type === "queue")).toBe(false);
    expect(capability.queue).toBeUndefined();
    expect(capability.health).toBeUndefined();
    expect(capability.dependsOn ?? []).not.toContain("secrets");
    expect(capability.auditSinks).toEqual({});
  });

  test("a declared sink binds the queue it consumes and its dead-letter queue, and reads its token through secrets", () => {
    const capability = audit({ sinks: SINKS });
    const queues = capability.requiredBindings.filter((binding) => binding.type === "queue");
    expect(queues.map((binding) => [binding.name, binding.optional, binding.consumer])).toEqual([
      [
        AUDIT_SHIP_BINDING,
        false,
        { deadLetter: AUDIT_SHIP_DLQ_BINDING, maxRetries: AUDIT_SHIP_MAX_RETRIES, maxBatchSize: 50 },
      ],
      [AUDIT_SHIP_DLQ_BINDING, true, undefined],
    ]);
    expect(capability.dependsOn).toContain("secrets");
    expect(Object.keys(capability.secretRegistry ?? {})).toEqual(["hook-token", "hec"]);
    expect(capability.queue).toBeTypeOf("function");
    // Nothing on it calls Cloudflare, so nothing joins the application's one runtime token.
    expect(capability.runtimePermissions ?? []).toEqual([]);
  });

  test("an unknown profile, or a sink with no secret name, is refused at config load", () => {
    expect(() => audit({ sinks: { x: { ...SINKS.everything, profile: "graylog" as never } } })).toThrow(/profile/);
    const { secret: _, ...unnamed } = SINKS.everything;
    expect(() => audit({ sinks: { x: unnamed as never } })).toThrow(/secret/);
  });

  test("no control-plane route creates, changes or removes a sink: every admin route is a read", () => {
    const routes = audit({ sinks: SINKS }).adminRoutes ?? [];
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.method, route.path).toBe("GET");
      expect(route.path, route.path).not.toMatch(/sink/i);
    }
  });

  test("every event written is enqueued, once per sink that takes it, naming the event and nothing personal", async () => {
    const sendBatch = vi.fn(async () => {});
    const backend = createBackend({
      capabilities: [secretsStandIn, audit({ sinks: SINKS })],
      app: emitting("auth/login", "u-1"),
    });
    const res = await backend.request("/act", { method: "POST" }, { ...env, [AUDIT_SHIP_BINDING]: { sendBatch } });
    expect(res.status, await res.clone().text()).toBe(200);

    const [event] = await queryAuditEvents(auditDatabase(env.DB), { actorId: "u-1" });
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch).toHaveBeenCalledWith([
      { body: { capability: "audit", sink: "everything", eventId: event?.eventId } },
      { body: { capability: "audit", sink: "auth", eventId: event?.eventId } },
    ]);
    expect(JSON.stringify(sendBatch.mock.calls)).not.toContain("203.0.113.4");
  });

  test("a sink's filter keeps an event it does not take off its queue", async () => {
    const sendBatch = vi.fn(async () => {});
    const backend = createBackend({
      capabilities: [secretsStandIn, audit({ sinks: SINKS })],
      app: emitting("payments/refund", "u-2"),
    });
    await backend.request("/act", { method: "POST" }, { ...env, [AUDIT_SHIP_BINDING]: { sendBatch } });
    const sinks = (sendBatch.mock.calls[0] as unknown as [{ body: { sink: string } }[]])[0].map((m) => m.body.sink);
    expect(sinks).toEqual(["everything"]);
  });

  test("a failing enqueue never fails the write: the event is recorded and the request answers", async () => {
    const sendBatch = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    const backend = createBackend({
      capabilities: [secretsStandIn, audit({ sinks: SINKS })],
      app: emitting("auth/login", "u-3"),
    });
    const res = await backend.request("/act", { method: "POST" }, { ...env, [AUDIT_SHIP_BINDING]: { sendBatch } });
    expect(res.status).toBe(200);
    expect(sendBatch).toHaveBeenCalled();
    expect(await queryAuditEvents(auditDatabase(env.DB), { actorId: "u-3" })).toHaveLength(1);
  });

  test("a Worker with sinks declared and no queue bound still records every event", async () => {
    const backend = createBackend({
      capabilities: [secretsStandIn, audit({ sinks: SINKS })],
      app: emitting("auth/login", "u-4"),
    });
    // The binding is declared required, so this is the Worker deployed before `pithy upgrade` wrote it: the env
    // still carries a stand-in name so assembly passes, and the stand-in is not a queue.
    const res = await backend.request("/act", { method: "POST" }, { ...env, [AUDIT_SHIP_BINDING]: {} });
    expect(res.status).toBe(200);
    expect(await queryAuditEvents(auditDatabase(env.DB), { actorId: "u-4" })).toHaveLength(1);
  });
});

describe("audit({ sinks }).auditRecorder — the recorder a Workflow step writes through (#622)", () => {
  const step = (actorId: string) => ({
    action: "auth/admin_user_purged",
    outcome: "success" as const,
    actorType: "system" as const,
    actorId,
    ip: "203.0.113.4",
  });

  test("every event it writes is enqueued, once per sink that takes it, naming the event and nothing personal", async () => {
    const sendBatch = vi.fn(async () => {});
    const recorder = audit({ sinks: SINKS }).auditRecorder;
    await recorder?.({ ...env, [AUDIT_SHIP_BINDING]: { sendBatch } })(step("wf-1"));

    const [event] = await queryAuditEvents(auditDatabase(env.DB), { actorId: "wf-1" });
    expect(event).toBeDefined();
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch).toHaveBeenCalledWith([
      { body: { capability: "audit", sink: "everything", eventId: event?.eventId } },
      { body: { capability: "audit", sink: "auth", eventId: event?.eventId } },
    ]);
    expect(JSON.stringify(sendBatch.mock.calls)).not.toContain("203.0.113.4");
  });

  test("a failing enqueue never fails the step's write: the event is recorded and the call resolves", async () => {
    const sendBatch = vi.fn(async () => {
      throw new Error("queue unavailable");
    });
    const recorder = audit({ sinks: SINKS }).auditRecorder;
    await expect(recorder?.({ ...env, [AUDIT_SHIP_BINDING]: { sendBatch } })(step("wf-2"))).resolves.toBeUndefined();
    expect(sendBatch).toHaveBeenCalled();
    expect(await queryAuditEvents(auditDatabase(env.DB), { actorId: "wf-2" })).toHaveLength(1);
  });

  test("with sinks declared and no queue bound, the step's event is still recorded", async () => {
    const recorder = audit({ sinks: SINKS }).auditRecorder;
    await expect(recorder?.({ ...env })(step("wf-3"))).resolves.toBeUndefined();
    expect(await queryAuditEvents(auditDatabase(env.DB), { actorId: "wf-3" })).toHaveLength(1);
  });
});
