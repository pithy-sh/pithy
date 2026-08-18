// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PithyError } from "../error/pithyError";
import { loopbackWorkflowBinding } from "./loopback";
import type { WorkflowBinding } from "./spec";

/**
 * The loopback dispatcher: the same one-method seam, carried over `<STEM>_ORIGIN` instead of a
 * cross-script binding. This is what `pithy dev` composes in place of the binding, so a call that
 * cannot reach the sibling must say *the sibling* failed — `core/upstream_failed`, never a 500 that
 * sends the operator to read our logs.
 */

/** A fetch that records the one call it was given and answers whatever the test asked for. */
function recordingFetch(answer: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return answer();
    },
  };
}

/** The dispatch response a host answers with. */
function accepted(): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ binding: "EMAIL_SENDER", id: "b1", started: true }), {
      status: 202,
      headers: { "content-type": "application/json" },
    }),
  );
}

/** Read the payload off a thrown `PithyError`, failing the test if something else was thrown. */
function payloadOf(error: unknown) {
  expect(error).toBeInstanceOf(PithyError);
  return (error as PithyError).payload;
}

describe("loopbackWorkflowBinding", () => {
  test("it satisfies the dispatch seam, so nothing at the call site changes", () => {
    const binding: WorkflowBinding = loopbackWorkflowBinding({ origin: "http://localhost:8797", binding: "X" });
    expect(typeof binding.create).toBe("function");
  });

  test("it posts the id and the params to the sibling's dispatch route", async () => {
    const transport = recordingFetch(accepted);
    const binding = loopbackWorkflowBinding({
      origin: "http://localhost:8797",
      binding: "EMAIL_SENDER",
      capability: "email",
      fetch: transport.fetch,
    });

    await binding.create({ id: "b1", params: { jobIds: ["j1"] } });

    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0];
    expect(call?.url).toBe("http://localhost:8797/__pithy/workflows/EMAIL_SENDER");
    expect(call?.init.method).toBe("POST");
    expect(JSON.parse(String(call?.init.body))).toEqual({ id: "b1", params: { jobIds: ["j1"] } });
  });

  test("a trailing slash on the origin does not become a doubled one", async () => {
    const transport = recordingFetch(accepted);
    const binding = loopbackWorkflowBinding({
      origin: "http://localhost:8797/",
      binding: "EMAIL_SENDER",
      fetch: transport.fetch,
    });

    await binding.create({ id: "b1", params: {} });
    expect(transport.calls[0]?.url).toBe("http://localhost:8797/__pithy/workflows/EMAIL_SENDER");
  });

  test("a sibling that cannot be reached is core/upstream_failed, not core/internal", async () => {
    const binding = loopbackWorkflowBinding({
      origin: "http://localhost:8797",
      binding: "EMAIL_SENDER",
      capability: "email",
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });

    try {
      await binding.create({ id: "b1", params: {} });
      expect.unreachable("an unreachable sibling must refuse");
    } catch (error) {
      const payload = payloadOf(error);
      expect(payload.code).toBe("core/upstream_failed");
      expect(payload.status).toBe(502);
      expect(payload.action).toContain("email");
      expect(payload.detail).toContain("http://localhost:8797/__pithy/workflows/EMAIL_SENDER");
    }
  });

  test("a sibling that answers with a failure status is core/upstream_failed, carrying the status", async () => {
    const binding = loopbackWorkflowBinding({
      origin: "http://localhost:8797",
      binding: "EMAIL_SENDER",
      fetch: async () => new Response('{"error":{"code":"auth/forbidden"}}', { status: 403 }),
    });

    try {
      await binding.create({ id: "b1", params: {} });
      expect.unreachable("a refused dispatch must refuse here too");
    } catch (error) {
      const payload = payloadOf(error);
      expect(payload.code).toBe("core/upstream_failed");
      expect(payload.detail).toContain("403");
      expect(payload.detail).toContain("auth/forbidden");
    }
  });

  test("a sibling that never answers is core/upstream_timeout — the send may yet have been applied", async () => {
    const binding = loopbackWorkflowBinding({
      origin: "http://localhost:8797",
      binding: "EMAIL_SENDER",
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
        }),
    });

    try {
      await binding.create({ id: "b1", params: {} });
      expect.unreachable("a hung sibling must not hang the caller");
    } catch (error) {
      const payload = payloadOf(error);
      expect(payload.code).toBe("core/upstream_timeout");
      expect(payload.status).toBe(504);
    }
  });

  test("the host's answer comes back to the caller", async () => {
    const binding = loopbackWorkflowBinding({
      origin: "http://localhost:8797",
      binding: "EMAIL_SENDER",
      fetch: accepted,
    });
    expect(await binding.create({ id: "b1", params: {} })).toEqual({
      binding: "EMAIL_SENDER",
      id: "b1",
      started: true,
    });
  });
});
