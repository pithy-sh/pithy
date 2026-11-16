// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { type HookRuntime, requestRuntime } from "./runtime";

/** An `ExecutionContext` that records what it was asked to keep alive, and fails if called unbound. */
function executionContext(kept: Promise<unknown>[]) {
  const ctx = {
    kept,
    waitUntil(this: { kept: Promise<unknown>[] } | undefined, promise: Promise<unknown>): void {
      if (this?.kept !== kept) throw new Error("waitUntil was called off its context");
      this.kept.push(promise);
    },
    passThroughOnException(): void {},
    props: {},
  };
  return ctx;
}

describe("requestRuntime", () => {
  test("hands a hook this request's env, and a waitUntil bound to its ExecutionContext", async () => {
    const kept: Promise<unknown>[] = [];
    const env = { DB: {}, MARKER: "env" };
    let runtime: HookRuntime | undefined;
    const app = new Hono();
    app.get("/", (c) => {
      runtime = requestRuntime(c);
      return c.text("ok");
    });
    await app.request("/", {}, env, executionContext(kept) as never);

    expect(runtime?.env).toBe(env);
    const { waitUntil } = runtime ?? {};
    const work = Promise.resolve("done");
    waitUntil?.(work);
    expect(kept).toEqual([work]);
  });

  test("leaves waitUntil absent when the request carries no ExecutionContext, where Hono's getter throws", async () => {
    let runtime: HookRuntime | undefined;
    const app = new Hono();
    app.get("/", (c) => {
      runtime = requestRuntime(c);
      return c.text("ok");
    });
    await app.request("/", {}, { DB: {} });

    expect(runtime).toBeDefined();
    expect(runtime?.env).toEqual({ DB: {} });
    expect(runtime && "waitUntil" in runtime).toBe(false);
  });

  test("leaves waitUntil absent for a context with no executionCtx at all", () => {
    const env = { DB: {} };
    const runtime = requestRuntime({ env } as never);
    expect(runtime).toEqual({ env });
  });
});
