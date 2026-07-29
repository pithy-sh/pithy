import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "./capability/capability";
import { createEntrypoint } from "./createEntrypoint";
import { PithyError } from "./error/pithyError";

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
    expect(await res.json()).toEqual({ status: "ok" });
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
    await entry.scheduled(null, { EMAIL_SCHEDULER: binding }, ctx);
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
    await entry.scheduled?.(null, { EMAIL_SENDER: sender, EMAIL_SCHEDULER: scheduler }, ctx);
    expect(sender.started).toEqual([]);
    expect(scheduler.started).toEqual([{}]);
  });

  test("crons across capabilities all fire from the one handler", async () => {
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
          name: "email",
          requiredBindings: [],
          workflows: {
            schedule: { binding: "EMAIL_SCHEDULER", params: NoParams, className: "E", schedule: "* * * * *" },
          },
        }),
      ],
    });
    await entry.scheduled?.(null, { STORAGE_SWEEP: a, EMAIL_SCHEDULER: b }, ctx);
    expect(a.started).toEqual([{}]);
    expect(b.started).toEqual([{}]);
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
            schedule: { binding: "EMAIL_SCHEDULER", params: NoParams, className: "E", schedule: "* * * * *" },
          },
        }),
      ],
    });

    const error = await entry.scheduled?.(null, { EMAIL_SCHEDULER: healthy }, ctx).catch((e: unknown) => e);
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
            schedule: { binding: "EMAIL_SCHEDULER", params: NoParams, className: "E", schedule: "* * * * *" },
          },
        }),
      ],
    });

    await expect(entry.scheduled?.(null, { EMAIL_SCHEDULER: healthy }, ctx)).resolves.toBeUndefined();
    expect(healthy.started).toEqual([{}]);
  });
});
