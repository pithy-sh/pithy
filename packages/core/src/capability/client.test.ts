// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { PithyError } from "../error/pithyError";
import { type Capability, defineCapability } from "./capability";
import { ClientProjection, type ClientProjectionContext, JsonValue, resolveClientProjection } from "./client";

const context: ClientProjectionContext = { environment: "production" };

describe("JsonValue", () => {
  test("accepts the JSON value space, nested", () => {
    const value = { a: "s", b: 1, c: true, d: null, e: [1, { f: [] }] };
    expect(JsonValue.parse(value)).toEqual(value);
  });

  test("rejects what JSON cannot carry", () => {
    expect(JsonValue.safeParse(() => 1).success).toBe(false);
    expect(JsonValue.safeParse(new Date()).success).toBe(false);
    expect(JsonValue.safeParse(undefined).success).toBe(false);
    expect(JsonValue.safeParse(Number.NaN).success).toBe(false);
    expect(JsonValue.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(JsonValue.safeParse(new Map()).success).toBe(false);
    expect(JsonValue.safeParse({ nested: { deep: new Date() } }).success).toBe(false);
  });
});

describe("ClientProjection", () => {
  test("requires enabled and keeps a capability's own JSON keys", () => {
    expect(ClientProjection.parse({ enabled: true, basePath: "/auth", providers: ["google"] })).toEqual({
      enabled: true,
      basePath: "/auth",
      providers: ["google"],
    });
    expect(ClientProjection.safeParse({ basePath: "/auth" }).success).toBe(false);
  });

  test("rejects a non-JSON extra key", () => {
    expect(ClientProjection.safeParse({ enabled: true, at: new Date() }).success).toBe(false);
    expect(ClientProjection.safeParse({ enabled: true, render: () => "x" }).success).toBe(false);
  });
});

describe("resolveClientProjection", () => {
  test("an absent capability projects as disabled", () => {
    expect(resolveClientProjection(undefined, context)).toEqual({ enabled: false });
  });

  test("a capability with no client projection is disabled", () => {
    const cap = defineCapability({ name: "storage", requiredBindings: [] });
    expect(resolveClientProjection(cap, context)).toEqual({ enabled: false });
  });

  test("resolves a declared projection against the context", () => {
    const cap = defineCapability({
      name: "example",
      requiredBindings: [],
      client: ({ environment }) => ({ enabled: true, environment }),
    });
    expect(resolveClientProjection(cap, { environment: "staging" })).toEqual({
      enabled: true,
      environment: "staging",
    });
  });

  test("a non-JSON projection is a build failure, not a bundle", () => {
    // The projection type already forbids these; the cast models a capability author who defeated it.
    const leaking = (value: unknown): Capability => ({
      name: "leaky",
      requiredBindings: [],
      client: () => ({ enabled: true, leaked: value }) as ClientProjection,
    });
    for (const value of [new Date(), () => "token", Number.NaN, new Map()]) {
      expect(() => resolveClientProjection(leaking(value), context)).toThrow(PithyError);
    }
    expect(() => resolveClientProjection(leaking(new Date()), context)).toThrow(/leaky/);
  });

  test("validates the context — an empty environment cannot resolve a per-environment value", () => {
    const cap = defineCapability({
      name: "example",
      requiredBindings: [],
      client: () => ({ enabled: true }),
    });
    expect(() => resolveClientProjection(cap, { environment: "" })).toThrow();
  });
});
