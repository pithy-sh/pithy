// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
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

/**
 * The key that vanishes, at the depths a projection actually has. `vanishingKey.test.ts` walks the schema
 * and proves both guards are on; this asks the question a capability author would — does writing that key
 * anywhere in a projection get reported, or does it disappear.
 *
 * `JSON.parse` everywhere: a `{ __proto__: … }` literal sets the prototype and writes no own key, so a
 * test spelled that way probes nothing and passes with the guards removed.
 */
describe("a projection stating a key that would vanish is refused, not quietly emptied", () => {
  test("at the top level", () => {
    expect(ClientProjection.safeParse(JSON.parse('{"enabled":true,"__proto__":{"a":1}}')).success).toBe(false);
  });

  test("one level down, where every value lives in the JSON space", () => {
    expect(
      ClientProjection.safeParse(JSON.parse('{"enabled":true,"catalog":{"__proto__":{"a":1},"ok":2}}')).success,
    ).toBe(false);
  });

  test("inside an array, and at a depth nobody enumerated", () => {
    expect(ClientProjection.safeParse(JSON.parse('{"enabled":true,"plans":[{"deep":{"__proto__":1}}]}')).success).toBe(
      false,
    );
    expect(JsonValue.safeParse(JSON.parse('[[{"__proto__":1}]]')).success).toBe(false);
  });

  test("the projection it would otherwise have become is the reason this is refused", () => {
    // Without a guard the parse succeeds and the key is simply not in the result — no issue, nothing
    // downstream able to tell it was written. That is the shape being refused, spelled out.
    const stated = JSON.parse('{"enabled":true,"catalog":{"__proto__":{"a":1},"ok":2}}') as {
      catalog: Record<string, unknown>;
    };
    expect(Object.hasOwn(stated.catalog, "__proto__")).toBe(true);
    expect(z.record(z.string(), z.unknown()).parse(stated.catalog)).toEqual({ ok: 2 });
  });

  test("a capability that writes one is a build failure, not a bundle", () => {
    const cap = defineCapability({
      name: "leaky",
      requiredBindings: [],
      client: () => JSON.parse('{"enabled":true,"__proto__":{"a":1}}') as ClientProjection,
    });
    expect(() => resolveClientProjection(cap, context)).toThrow(PithyError);
    expect(() => resolveClientProjection(cap, context)).toThrow(/leaky/);
  });

  test("the name it shares with every object is still just a name", () => {
    // Inherited, not stated. Refusing on that would refuse every projection there is.
    expect(ClientProjection.parse({ enabled: true, sitekey: "k" })).toEqual({ enabled: true, sitekey: "k" });
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
