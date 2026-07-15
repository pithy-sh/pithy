import { describe, expect, test } from "vitest";
import type { LogRecord } from "./record";
import { bindRequestContext, createWorkerLogger } from "./worker";

/** Capture emitted records (bypassing console) plus an optional transport spy. */
function capture(options: Partial<Parameters<typeof createWorkerLogger>[0]> = {}) {
  const emitted: LogRecord[] = [];
  const log = createWorkerLogger({ emit: (r) => emitted.push(r), now: () => 1, ...options });
  return { emitted, log };
}

describe("createWorkerLogger", () => {
  test("emits one structured record per log call", () => {
    const { emitted, log } = capture();
    log.info("served", { status: 200 });
    expect(emitted).toEqual([{ level: "info", msg: "served", time: 1, fields: { status: 200 } }]);
  });

  test("defaults to info — debug is dropped on a deployed Worker", () => {
    const { emitted, log } = capture();
    log.debug("noisy");
    log.info("kept");
    expect(emitted.map((r) => r.level)).toEqual(["info"]);
  });

  test("fans every emitted record to the transport hook unchanged", () => {
    const forwarded: LogRecord[] = [];
    const { emitted, log } = capture({ transport: (r) => forwarded.push(r) });
    log.warn("slow");
    expect(forwarded).toEqual(emitted);
    expect(forwarded).toHaveLength(1);
  });

  test("never throws when a field is non-serializable (circular / BigInt) — the default emit is crash-proof", () => {
    const seen: string[] = [];
    const original = console.log;
    console.log = (line: string) => seen.push(line);
    try {
      const log = createWorkerLogger({ now: () => 1 });
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => log.error("boom", { cyclic, big: 10n })).not.toThrow();
    } finally {
      console.log = original;
    }
    // A line was still emitted, and it parses — cycle replaced, BigInt stringified.
    const parsed = JSON.parse(seen[0] ?? "") as { fields?: { cyclic?: { self?: string }; big?: string } };
    expect(parsed.fields?.cyclic?.self).toBe("[Circular]");
    expect(parsed.fields?.big).toBe("10");
  });

  test("the default emit writes one JSON line to console.log", () => {
    const seen: string[] = [];
    const original = console.log;
    console.log = (line: string) => seen.push(line);
    try {
      createWorkerLogger({ now: () => 1 }).error("down");
    } finally {
      console.log = original;
    }
    expect(JSON.parse(seen[0] ?? "") as LogRecord).toEqual({ level: "error", msg: "down", time: 1 });
  });
});

describe("bindRequestContext", () => {
  test("binds request-correlation fields onto every record, without a namespace", () => {
    const { emitted, log } = capture();
    const req = bindRequestContext(log, {
      request: "ray-1",
      method: "POST",
      path: "/login",
      env: "production",
      version: "v9",
    });
    req.info("handled");
    expect(emitted[0]?.name).toBeUndefined();
    expect(emitted[0]?.fields).toEqual({
      request: "ray-1",
      method: "POST",
      path: "/login",
      env: "production",
      version: "v9",
    });
  });

  test("omits version when there is none, and leaves the namespace free for a capability", () => {
    const { emitted, log } = capture();
    const req = bindRequestContext(log, { request: "r", method: "GET", path: "/", env: "dev" });
    req.child("auth").info("ok");
    expect(emitted[0]?.name).toBe("auth");
    expect(emitted[0]?.fields).toEqual({ request: "r", method: "GET", path: "/", env: "dev" });
    expect(emitted[0]?.fields?.version).toBeUndefined();
  });
});
