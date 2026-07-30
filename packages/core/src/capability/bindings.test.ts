// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { BindingSpec, BindingType } from "./bindings";

describe("BindingType", () => {
  test("accepts each known resource kind", () => {
    for (const t of [
      "d1",
      "kv",
      "r2",
      "ai",
      "vectorize",
      "queue",
      "ratelimit",
      "email",
      "secret",
      "workflow",
      "service",
      "durable_object",
    ]) {
      expect(BindingType.parse(t)).toBe(t);
    }
  });

  test("rejects an unknown kind", () => {
    expect(() => BindingType.parse("banana")).toThrow();
  });
});

describe("BindingSpec", () => {
  test("parses a valid binding, defaulting optional to false", () => {
    expect(BindingSpec.parse({ type: "d1", name: "DB" })).toEqual({
      type: "d1",
      name: "DB",
      optional: false,
    });
  });

  test("rejects an unknown binding type", () => {
    expect(() => BindingSpec.parse({ type: "banana", name: "Q" })).toThrow();
  });

  test("rejects an empty name", () => {
    expect(() => BindingSpec.parse({ type: "kv", name: "" })).toThrow();
  });

  test("parses a durable_object binding carrying its class name", () => {
    expect(BindingSpec.parse({ type: "durable_object", name: "SESSIONS", className: "MultiplayerSession" })).toEqual({
      type: "durable_object",
      name: "SESSIONS",
      optional: false,
      className: "MultiplayerSession",
    });
  });

  test("rejects a durable_object binding with no className", () => {
    expect(() => BindingSpec.parse({ type: "durable_object", name: "SESSIONS" })).toThrow(/className/);
  });
});

describe("BindingType descriptions", () => {
  test("every option carries a non-empty description (self-documenting)", () => {
    expect(BindingType.options).toHaveLength(12);
    for (const option of BindingType.options) {
      expect(option.description).toBeTruthy();
    }
  });
});
