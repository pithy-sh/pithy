// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { deferred, deferredMiddleware, deferredSettings, deferredValue } from "./deferred";
import type { CapabilitySettings, SettingsAccountContext, SettingsCheckContext } from "./settings";

describe("deferred", () => {
  it("loads nothing until the first call, then answers with the loaded function", async () => {
    const load = vi.fn(async () => (a: number, b: number) => a + b);
    const add = deferred(load);
    expect(load).not.toHaveBeenCalled();
    await expect(add(2, 3)).resolves.toBe(5);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads once, however many calls arrive while it is loading", async () => {
    let release: (value: (x: string) => string) => void = () => undefined;
    const load = vi.fn(() => new Promise<(x: string) => string>((resolve) => (release = resolve)));
    const echo = deferred(load);
    const calls = [echo("a"), echo("b"), echo("c")];
    release((x) => x.toUpperCase());
    await expect(Promise.all(calls)).resolves.toEqual(["A", "B", "C"]);
    await echo("d");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("tries a failed load again on the next call", async () => {
    const load = vi
      .fn<() => Promise<() => string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(() => "ok");
    const call = deferred(load);
    await expect(call()).rejects.toThrow("offline");
    await expect(call()).resolves.toBe("ok");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("passes a rejection from the loaded function through unchanged", async () => {
    const fault = new TypeError("bad input");
    const call = deferred(async () => async () => {
      throw fault;
    });
    await expect(call()).rejects.toBe(fault);
  });
});

describe("deferredValue", () => {
  it("builds the value on first use and hands the same one to every later caller", async () => {
    const build = vi.fn(async () => ({ id: Math.random() }));
    const value = deferredValue(build);
    expect(build).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([value(), value()]);
    expect(a).toBe(b);
    expect(await value()).toBe(a);
    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe("deferredMiddleware", () => {
  it("runs the loaded middleware in place, and loads it on the first request", async () => {
    const load = vi.fn(async () => async (c: { header: (k: string, v: string) => void }, next: () => Promise<void>) => {
      c.header("x-loaded", "1");
      await next();
    });
    const app = new Hono();
    app.use("*", deferredMiddleware(load));
    app.get("/", (c) => c.text("hi"));
    expect(load).not.toHaveBeenCalled();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-loaded")).toBe("1");
    expect(await res.text()).toBe("hi");
    await app.request("/");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("answers with the loaded middleware's own response when it does not call next", async () => {
    const app = new Hono();
    app.use(
      "*",
      deferredMiddleware(async () => async (c: { text: (t: string, s: number) => Response }) => c.text("refused", 403)),
    );
    app.get("/", (c) => c.text("hi"));
    const res = await app.request("/");
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("refused");
  });
});

describe("deferredSettings", () => {
  const local = {} as SettingsCheckContext;
  const account = {} as SettingsAccountContext;

  it("loads the checks on the first call and answers with theirs", async () => {
    const checks: CapabilitySettings = {
      local: () => [{ level: "pass", message: "Local." }] as never,
      account: async () => [{ level: "pass", message: "Account." }] as never,
    };
    const load = vi.fn(async () => checks);
    const settings = deferredSettings(load, { account: true });
    expect(load).not.toHaveBeenCalled();
    expect(await settings.local(local)).toEqual([{ level: "pass", message: "Local." }]);
    expect(await settings.account?.(account)).toEqual([{ level: "pass", message: "Account." }]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("has no account check when the loaded checks have none, so a caller can tell before loading", () => {
    const settings = deferredSettings(async () => ({ local: () => [] }), { account: false });
    expect(settings.account).toBeUndefined();
  });
});
