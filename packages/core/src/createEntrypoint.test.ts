// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { defineCapability } from "./capability/capability";
import { createBackend } from "./createBackend";
import { createEntrypoint } from "./createEntrypoint";
import { PithyError } from "./error/pithyError";
import { SERVICE_ORIGINS_VAR } from "./worker/serviceLoopback";

/** A minimal stand-in for a `ForwardableEmailMessage` — enough to exercise the fan-out + raw replay. */
function fakeMessage(body: string): ForwardableEmailMessage {
  return {
    from: "bounce@pithy.sh",
    to: "ignored@example.com",
    headers: new Headers({ subject: "Delivery Status Notification" }),
    raw: new Response(body).body as ReadableStream<Uint8Array>,
    rawSize: body.length,
    setReject() {},
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("createEntrypoint", () => {
  test("fetch delegates to the composed Hono app", async () => {
    const entry = createEntrypoint({ capabilities: [] });
    const res = await entry.fetch(new Request("http://x/health"), {}, ctx);
    expect(res.status).toBe(200);
    // `version` is null with no `CF_VERSION_METADATA` binding — honest rather than misleading, and what
    // `pithy deploy` reads as "cannot tell" instead of as a failed check.
    expect(await res.json()).toEqual({ status: "ok", version: null });
  });

  /**
   * **Under `pithy dev`, a service binding reaches its target's pinned port (#617).** The binding is required, so
   * `validateBindings` has to see it — which it does, because the stand-in is in the env before the app runs.
   */
  test("under dev, a published service binding is in env and reaches the local target", async () => {
    const calls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return new Response("from app-b");
    }) as typeof fetch);
    try {
      const app = defineCapability({
        name: "appa",
        requiredBindings: [{ type: "service", name: "APP_B", service: "app-b" }],
        routes: (a) => {
          a.get("/call", async (c) => {
            const service = (c.env as { APP_B: { fetch: (input: string) => Promise<Response> } }).APP_B;
            return c.text(await (await service.fetch("https://app-b/hello")).text());
          });
        },
      });
      const entry = createEntrypoint({ capabilities: [], app });
      const env = { ENVIRONMENT: "dev", [SERVICE_ORIGINS_VAR]: JSON.stringify({ APP_B: "http://localhost:8790" }) };
      const res = await entry.fetch(new Request("http://x/call"), env, ctx);
      expect(await res.text()).toBe("from app-b");
      expect(calls).toEqual(["http://localhost:8790/hello"]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("no email handler is exposed when no capability declares one (so mail isn't silently dropped)", () => {
    const entry = createEntrypoint({ capabilities: [] });
    expect(entry.email).toBeUndefined();
  });

  test("email routes the message to a single capability handler", async () => {
    let seen: { from: string; body: string } | undefined;
    const cap = defineCapability({
      name: "inbound",
      requiredBindings: [],
      email: async (message) => {
        seen = { from: message.from, body: await new Response(message.raw).text() };
      },
    });
    const entry = createEntrypoint({ capabilities: [cap] });
    if (!entry.email) throw new Error("expected an email handler");
    await entry.email(fakeMessage("hello"), {}, ctx);
    expect(seen).toEqual({ from: "bounce@pithy.sh", body: "hello" });
  });

  test("every handler can read raw independently — the single-use stream is replayed", async () => {
    const bodies: string[] = [];
    const make = (name: string) =>
      defineCapability({
        name,
        requiredBindings: [],
        email: async (message) => {
          bodies.push(await new Response(message.raw).text());
        },
      });
    const entry = createEntrypoint({ capabilities: [make("a"), make("b")] });
    if (!entry.email) throw new Error("expected an email handler");
    await entry.email(fakeMessage("dsn-report"), {}, ctx);
    expect(bodies).toEqual(["dsn-report", "dsn-report"]);
  });
});

/** A Workflow binding that records every instance it was asked to start. */
function fakeWorkflow() {
  const started: unknown[] = [];
  return { started, create: async (options?: { params?: unknown }) => void started.push(options?.params) };
}

const NoParams = z.object({}).describe("A scheduled job takes no caller input.");

describe("createEntrypoint scheduled", () => {
  test("no scheduled handler is exposed when no job carries a cron", () => {
    const cap = defineCapability({
      name: "email",
      requiredBindings: [],
      workflows: { send: { binding: "EMAIL_SENDER", params: NoParams, className: "EmailSendWorkflow" } },
    });
    expect(createEntrypoint({ capabilities: [cap] }).scheduled).toBeUndefined();
  });

  test("a cron-carrying job gets the Worker's scheduled entry", async () => {
    const binding = fakeWorkflow();
    const cap = defineCapability({
      name: "email",
      requiredBindings: [],
      workflows: {
        schedule: {
          binding: "EMAIL_SCHEDULER",
          params: NoParams,
          className: "EmailSchedulerWorkflow",
          schedule: "* * * * *",
        },
      },
    });
    const entry = createEntrypoint({ capabilities: [cap] });
    if (!entry.scheduled) throw new Error("expected a scheduled handler");
    await entry.scheduled({ cron: "* * * * *" }, { EMAIL_SCHEDULER: binding }, ctx);
    expect(binding.started).toEqual([{}]);
  });

  test("only scheduled jobs fire — a dispatch-only job is left alone", async () => {
    const sender = fakeWorkflow();
    const scheduler = fakeWorkflow();
    const cap = defineCapability({
      name: "email",
      requiredBindings: [],
      workflows: {
        send: { binding: "EMAIL_SENDER", params: NoParams, className: "EmailSendWorkflow" },
        schedule: {
          binding: "EMAIL_SCHEDULER",
          params: NoParams,
          className: "EmailSchedulerWorkflow",
          schedule: "0 * * * *",
        },
      },
    });
    const entry = createEntrypoint({ capabilities: [cap] });
    await entry.scheduled?.({ cron: "0 * * * *" }, { EMAIL_SENDER: sender, EMAIL_SCHEDULER: scheduler }, ctx);
    expect(sender.started).toEqual([]);
    expect(scheduler.started).toEqual([{}]);
  });

  test("crons across capabilities share the one handler, and each fires only on its own cron (#622)", async () => {
    const daily = fakeWorkflow();
    const hourly = fakeWorkflow();
    const entry = createEntrypoint({
      capabilities: [
        defineCapability({
          name: "storage",
          requiredBindings: [],
          workflows: {
            sweep: { binding: "STORAGE_SWEEP", params: NoParams, className: "S", schedule: "0 2 * * *" },
          },
        }),
        defineCapability({
          name: "payments",
          requiredBindings: [],
          workflows: {
            usage: { binding: "PAYMENTS_USAGE", params: NoParams, className: "P", schedule: "15 * * * *" },
          },
        }),
      ],
    });
    const env = { STORAGE_SWEEP: daily, PAYMENTS_USAGE: hourly };

    // The hourly cron, all day: the daily job never starts on it.
    for (let hour = 0; hour < 24; hour++) await entry.scheduled?.({ cron: "15 * * * *" }, env, ctx);
    expect(hourly.started).toHaveLength(24);
    expect(daily.started).toEqual([]);

    // The daily cron: the daily job starts once, and the hourly job gets no extra run.
    await entry.scheduled?.({ cron: "0 2 * * *" }, env, ctx);
    expect(daily.started).toEqual([{}]);
    expect(hourly.started).toHaveLength(24);
  });

  test("every job that declares the cron that fired starts on it", async () => {
    const a = fakeWorkflow();
    const b = fakeWorkflow();
    const entry = createEntrypoint({
      capabilities: [
        defineCapability({
          name: "storage",
          requiredBindings: [],
          workflows: {
            sweep: { binding: "STORAGE_SWEEP", params: NoParams, className: "S", schedule: "0 3 * * *" },
          },
        }),
        defineCapability({
          name: "media",
          requiredBindings: [],
          workflows: {
            sweep: { binding: "MEDIA_SWEEP", params: NoParams, className: "M", schedule: "0 3 * * *" },
          },
        }),
      ],
    });
    await entry.scheduled?.({ cron: "0 3 * * *" }, { STORAGE_SWEEP: a, MEDIA_SWEEP: b }, ctx);
    expect(a.started).toEqual([{}]);
    expect(b.started).toEqual([{}]);
  });

  test("an event that names no cron, or a cron no job declares, starts nothing", async () => {
    const binding = fakeWorkflow();
    const entry = createEntrypoint({
      capabilities: [
        defineCapability({
          name: "storage",
          requiredBindings: [],
          workflows: {
            sweep: { binding: "STORAGE_SWEEP", params: NoParams, className: "S", schedule: "0 3 * * *" },
          },
        }),
      ],
    });
    await entry.scheduled?.(null, { STORAGE_SWEEP: binding }, ctx);
    await entry.scheduled?.({}, { STORAGE_SWEEP: binding }, ctx);
    await entry.scheduled?.({ cron: "0 4 * * *" }, { STORAGE_SWEEP: binding }, ctx);
    expect(binding.started).toEqual([]);
  });

  test("one failing job does not stop the rest of the schedule, and the failure still surfaces", async () => {
    const healthy = fakeWorkflow();
    const entry = createEntrypoint({
      capabilities: [
        defineCapability({
          name: "storage",
          requiredBindings: [],
          // Binding deliberately absent from env, and not optional — so this one throws.
          workflows: {
            sweep: { binding: "STORAGE_SWEEP", params: NoParams, className: "S", schedule: "0 3 * * *" },
          },
        }),
        defineCapability({
          name: "email",
          requiredBindings: [],
          workflows: {
            schedule: { binding: "EMAIL_SCHEDULER", params: NoParams, className: "E", schedule: "0 3 * * *" },
          },
        }),
      ],
    });

    const error = await entry
      .scheduled?.({ cron: "0 3 * * *" }, { EMAIL_SCHEDULER: healthy }, ctx)
      .catch((e: unknown) => e);
    expect(healthy.started).toEqual([{}]);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.code).toBe("core/missing_workflow_binding");
  });

  test("an optional job with no binding degrades quietly instead of failing the whole invocation", async () => {
    const healthy = fakeWorkflow();
    const entry = createEntrypoint({
      capabilities: [
        defineCapability({
          name: "media",
          requiredBindings: [],
          workflows: {
            sweep: { binding: "MEDIA_SWEEP", params: NoParams, className: "M", schedule: "0 3 * * *", optional: true },
          },
        }),
        defineCapability({
          name: "email",
          requiredBindings: [],
          workflows: {
            schedule: { binding: "EMAIL_SCHEDULER", params: NoParams, className: "E", schedule: "0 3 * * *" },
          },
        }),
      ],
    });

    await expect(entry.scheduled?.({ cron: "0 3 * * *" }, { EMAIL_SCHEDULER: healthy }, ctx)).resolves.toBeUndefined();
    expect(healthy.started).toEqual([{}]);
  });
});

/**
 * **The seam a capability refuses a deployment at — and the reason it is not `compose` (#500).**
 *
 * `createBackend` is assembled by tooling as well as by Workers: `pithy ui` builds the app to read its
 * route tree, and the CLI runs every `compose` hook to read what a capability reports. `createEntrypoint`
 * is only ever called by a Worker's own `src/index.ts`. So a capability that must **load** for the
 * adopter's toolchain and must never **serve** — `@pithy-sh/payments` with a scaffolded, unimplemented
 * `resolveSubject` — refuses here, and every `pithy` command in that project keeps working.
 */
describe("createEntrypoint boot hooks", () => {
  test("runs every capability's boot hook, with the composed set", () => {
    const seen: string[][] = [];
    const make = (name: string) =>
      defineCapability({
        name,
        requiredBindings: [],
        boot: ({ capabilities }) => seen.push(capabilities.map((cap) => cap.name)),
      });

    createEntrypoint({ capabilities: [make("a"), make("b")] });

    expect(seen).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
  });

  test("a refusal from a boot hook is the Worker failing to start", () => {
    const cap = defineCapability({
      name: "refuser",
      requiredBindings: [],
      boot: () => {
        throw new PithyError({ code: "core/internal", status: 500, message: "not ready." });
      },
    });

    expect(() => createEntrypoint({ capabilities: [cap] })).toThrow(PithyError);
  });

  test("createBackend does not run it — that is the whole point of the split", async () => {
    let booted = false;
    const cap = defineCapability({ name: "quiet", requiredBindings: [], boot: () => (booted = true) });

    const app = createBackend({ capabilities: [cap] });
    await app.fetch(new Request("http://x/health"), {}, ctx);

    expect(booted).toBe(false);
  });

  test("boot runs after compose, so a hook sees what composition wired", () => {
    const order: string[] = [];
    const cap = defineCapability({
      name: "ordered",
      requiredBindings: [],
      compose: () => order.push("compose"),
      boot: () => order.push("boot"),
    });

    createEntrypoint({ capabilities: [cap] });

    expect(order).toEqual(["compose", "boot"]);
  });
});

describe("createEntrypoint queue", () => {
  test("no queue handler is exposed when no capability consumes one", () => {
    const cap = defineCapability({ name: "quiet", requiredBindings: [] });
    expect(createEntrypoint({ capabilities: [cap] }).queue).toBeUndefined();
  });

  test("a capability's consumer receives the messages that name it (#824)", async () => {
    const seen: string[] = [];
    const cap = defineCapability({
      name: "audit",
      requiredBindings: [],
      queue: async (messages) => {
        for (const message of messages) {
          seen.push(message.id);
          message.ack();
        }
      },
    });
    const ack = vi.fn();
    const entry = createEntrypoint({ capabilities: [cap] });
    await entry.queue?.(
      {
        queue: "acme-prod-audit-ship",
        messages: [{ id: "m1", body: { capability: "audit" }, attempts: 1, ack, retry: vi.fn() }],
      },
      {},
      ctx,
    );
    expect(seen).toEqual(["m1"]);
    expect(ack).toHaveBeenCalled();
  });
});
