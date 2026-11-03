// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { defineCapability } from "./capability/capability";
import { createEntrypoint } from "./createEntrypoint";
import { asForwardable, NativeLikeMessage } from "./test-utils/nativeLikeEmail";

/**
 * Inbound mail fanned to more than one handler, inside workerd.
 *
 * A `ForwardableEmailMessage` is a native object: `to`, `from`, `rawSize` and `headers` are accessors on its
 * prototype that refuse any `this` but the real message. The fan-out hands each handler a wrapper so the
 * single-use `raw` stream can be replayed, and a wrapper that read those accessors with itself as `this` threw
 * `Illegal invocation` on every one, in every composition with two handlers. A plain-object double has no
 * accessors and could never have caught it, so `NativeLikeMessage` refuses a foreign `this` the way workerd does.
 */

const BODY = "From: ada@example.com\r\nTo: help@acme.test\r\nSubject: Hi\r\n\r\nThe payment failed twice.";

function nativeLike(): NativeLikeMessage {
  return new NativeLikeMessage({
    to: "help@acme.test",
    from: "ada@example.com",
    headers: new Headers({ subject: "Hi" }),
    body: BODY,
  });
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

/** Everything a handler reads off the message, or the error it hit reading it. */
interface Seen {
  to: string;
  from: string;
  rawSize: number;
  subject: string | null;
  raw: string;
}

/** A capability whose handler reads every accessor and the raw body, and optionally acts on the message. */
function reader(name: string, seen: (Seen | Error)[], act?: (message: ForwardableEmailMessage) => Promise<unknown>) {
  return defineCapability({
    name,
    requiredBindings: [],
    email: async (message) => {
      try {
        seen.push({
          to: message.to,
          from: message.from,
          rawSize: message.rawSize,
          subject: message.headers.get("subject"),
          raw: await new Response(message.raw).text(),
        });
        await act?.(message);
      } catch (error) {
        seen.push(error as Error);
      }
    },
  });
}

const EXPECTED: Seen = {
  to: "help@acme.test",
  from: "ada@example.com",
  rawSize: BODY.length,
  subject: "Hi",
  raw: BODY,
};

describe("the double is faithful to workerd", () => {
  /** The premise the double stands on, measured on a native object in this runtime. */
  test("a native accessor read with a proxy as receiver throws Illegal invocation; with the target, it works", () => {
    const request = new Request("https://acme.test/x");
    const proxy = new Proxy(request, {});
    expect(() => Reflect.get(request, "url", proxy)).toThrow(/Illegal invocation/);
    expect(Reflect.get(request, "url", request)).toBe("https://acme.test/x");
  });

  test("the double refuses a foreign this the same way", () => {
    const message = nativeLike();
    const proxy = new Proxy(message, {});
    expect(() => Reflect.get(message, "to", proxy)).toThrow(/Illegal invocation/);
    expect(Reflect.get(message, "to", message)).toBe("help@acme.test");
  });
});

describe("createEntrypoint email, against native-like accessors", () => {
  test("with two handlers, each reads to, from, rawSize, headers and the full raw body", async () => {
    const seen: (Seen | Error)[] = [];
    const entry = createEntrypoint({ capabilities: [reader("bounces", seen), reader("support", seen)] });
    if (!entry.email) throw new Error("expected an email handler");
    await entry.email(asForwardable(nativeLike()), {}, ctx);
    expect(seen).toEqual([EXPECTED, EXPECTED]);
  });

  test("setReject and forward reach the real message through the wrapper", async () => {
    const seen: (Seen | Error)[] = [];
    const message = nativeLike();
    const entry = createEntrypoint({
      capabilities: [
        reader("first", seen, async (m) => m.setReject("no such inbox")),
        reader("second", seen, async (m) => m.forward("ops@acme.test")),
      ],
    });
    if (!entry.email) throw new Error("expected an email handler");
    await entry.email(asForwardable(message), {}, ctx);
    expect(seen).toEqual([EXPECTED, EXPECTED]);
    expect(message.rejected).toBe("no such inbox");
    expect(message.forwardedTo).toEqual(["ops@acme.test"]);
  });

  test("a single handler gets the message itself, unwrapped", async () => {
    const message = nativeLike();
    let given: unknown;
    const seen: (Seen | Error)[] = [];
    const cap = defineCapability({
      name: "only",
      requiredBindings: [],
      email: async (m) => {
        given = m;
        seen.push({
          to: m.to,
          from: m.from,
          rawSize: m.rawSize,
          subject: m.headers.get("subject"),
          raw: await new Response(m.raw).text(),
        });
      },
    });
    const entry = createEntrypoint({ capabilities: [cap] });
    if (!entry.email) throw new Error("expected an email handler");
    await entry.email(asForwardable(message), {}, ctx);
    expect(given).toBe(message);
    expect(seen).toEqual([EXPECTED]);
  });
});
