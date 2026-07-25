import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { describe, expect, test } from "vitest";
import { provisionableBindings, serviceBindings } from "./bindings";

/** A capability declaring an arbitrary set of bindings — the only field these tests exercise. */
function cap(name: string, bindings: { type: string; name: string; className?: string; service?: string }[]) {
  return defineCapability({
    name,
    // biome-ignore lint/suspicious/noExplicitAny: test fixture feeds raw binding specs through the parser.
    requiredBindings: bindings as any,
  });
}

describe("provisionableBindings", () => {
  test("keeps only d1/kv/r2 bindings, mapped to their resource kind", () => {
    const capability = cap("app", [
      { type: "d1", name: "DB" },
      { type: "kv", name: "SESSIONS" },
      { type: "r2", name: "ASSETS" },
      { type: "ai", name: "AI" },
      { type: "queue", name: "JOBS" },
      { type: "durable_object", name: "ROOMS", className: "Room" },
      { type: "service", name: "OTHER", service: "other" },
    ]);

    expect(provisionableBindings([capability])).toEqual([
      { binding: "DB", kind: "d1" },
      { binding: "SESSIONS", kind: "kv" },
      { binding: "ASSETS", kind: "r2" },
    ]);
  });

  test("dedupes a binding shared across capabilities — one resource backs it", () => {
    const a = cap("auth", [{ type: "d1", name: "DB" }]);
    const b = cap("app", [
      { type: "d1", name: "DB" },
      { type: "kv", name: "CACHE" },
    ]);

    expect(provisionableBindings([a, b])).toEqual([
      { binding: "DB", kind: "d1" },
      { binding: "CACHE", kind: "kv" },
    ]);
  });

  test("no provisionable bindings yields an empty list", () => {
    const capability = cap("app", [{ type: "ai", name: "AI" }]);
    expect(provisionableBindings([capability])).toEqual([]);
  });
});

describe("serviceBindings", () => {
  test("returns each service binding with the Worker it targets", () => {
    const capability = cap("app", [
      { type: "d1", name: "DB" },
      { type: "service", name: "API", service: "api" },
      { type: "service", name: "JOBS", service: "worker-jobs" },
    ]);

    expect(serviceBindings([capability])).toEqual([
      { binding: "API", target: "api" },
      { binding: "JOBS", target: "worker-jobs" },
    ]);
  });

  test("dedupes a binding declared by two capabilities", () => {
    const a = cap("auth", [{ type: "service", name: "API", service: "api" }]);
    const b = cap("app", [{ type: "service", name: "API", service: "api" }]);
    expect(serviceBindings([a, b])).toEqual([{ binding: "API", target: "api" }]);
  });

  test("no service bindings yields an empty list", () => {
    expect(serviceBindings([cap("app", [{ type: "d1", name: "DB" }])])).toEqual([]);
  });

  test("a service binding with no target is rejected at define time", () => {
    expect(() => cap("app", [{ type: "service", name: "API" }])).toThrow(/needs a service/);
  });
});
