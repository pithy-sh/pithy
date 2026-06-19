import { describe, expect, test } from "vitest";
import { defineCapability } from "./capability/capability";
import { createEntrypoint } from "./createEntrypoint";

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
