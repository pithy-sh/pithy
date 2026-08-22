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

  test("parses a durable_object binding carrying its class name and the module it comes from", () => {
    expect(
      BindingSpec.parse({
        type: "durable_object",
        name: "SESSIONS",
        className: "MultiplayerSession",
        classModule: "@pithy-sh/multiplayer/src/session/durableObject",
      }),
    ).toEqual({
      type: "durable_object",
      name: "SESSIONS",
      optional: false,
      className: "MultiplayerSession",
      classModule: "@pithy-sh/multiplayer/src/session/durableObject",
    });
  });

  test("rejects a durable_object binding with no className", () => {
    expect(() =>
      BindingSpec.parse({ type: "durable_object", name: "SESSIONS", classModule: "@pithy-sh/x/src/do" }),
    ).toThrow(/className/);
  });

  test("rejects a durable_object binding with no classModule", () => {
    // The other half of the binding. Without it the CLI writes the `durable_objects.bindings` entry and
    // the class migration tag, has nowhere to write the export from, and the deploy fails on a class
    // "not exported in your entrypoint file" (#428).
    expect(() => BindingSpec.parse({ type: "durable_object", name: "SESSIONS", className: "Session" })).toThrow(
      /classModule/,
    );
  });

  test("rejects a className that is not an identifier, and a classModule that is not a specifier", () => {
    // Both land in generated TypeScript — `export { <className> } from "<classModule>";` — built from a
    // manifest, which is third-party data read out of node_modules. The shape #183 closed one field up.
    const base = { type: "durable_object", name: "SESSIONS" };
    for (const className of ["Session } from 'evil'; //", "class-name", "1Session"]) {
      expect(() => BindingSpec.parse({ ...base, className, classModule: "@pithy-sh/x/src/do" })).toThrow(/className/);
    }
    for (const classModule of ['x"; import "evil', "@pithy-sh/x/../../elsewhere", "./local module"]) {
      expect(() => BindingSpec.parse({ ...base, className: "Session", classModule })).toThrow(/classModule/);
    }
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
