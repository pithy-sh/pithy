// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { BindingType } from "./bindings";
import { CapabilityManifest } from "./manifest";
import { appliedTestBindings, TestBinding, testBindingKind } from "./testBinding";

describe("TestBinding", () => {
  test("reads each kind a Workers test config can state", () => {
    expect(TestBinding.parse({ kind: "d1", name: "SECRETS" })).toEqual({ kind: "d1", name: "SECRETS" });
    expect(TestBinding.parse({ kind: "kv", name: "MATCHMAKING" })).toEqual({ kind: "kv", name: "MATCHMAKING" });
    expect(TestBinding.parse({ kind: "r2", name: "MEDIA_BUCKET" })).toEqual({ kind: "r2", name: "MEDIA_BUCKET" });
    expect(TestBinding.parse({ kind: "ratelimit", name: "AUTH_RATE_LIMITER", limit: 100, period: 60 })).toEqual({
      kind: "ratelimit",
      name: "AUTH_RATE_LIMITER",
      limit: 100,
      period: 60,
    });
    expect(
      TestBinding.parse({
        kind: "value",
        name: "SECRETS_ENCRYPTION_KEYS",
        module: "@pithy-sh/secrets/src/test-utils/devEncryptionKeys",
        export: "devEncryptionKeys",
      }),
    ).toMatchObject({ kind: "value", export: "devEncryptionKeys" });
    expect(TestBinding.parse({ kind: "unbound", name: "QUEUE" })).toEqual({ kind: "unbound", name: "QUEUE" });
  });

  test("refuses a name that is not a binding name", () => {
    // Each name is written into the adopter's TypeScript, as an array string or an object key.
    expect(TestBinding.safeParse({ kind: "d1", name: 'DB"]; evil(); ["' }).success).toBe(false);
    expect(TestBinding.safeParse({ kind: "d1", name: "1DB" }).success).toBe(false);
  });

  test("refuses a module that is not a path into a scoped package", () => {
    const value = { kind: "value", name: "KEY", export: "devKey" };
    expect(TestBinding.safeParse({ ...value, module: "./local" }).success).toBe(false);
    expect(TestBinding.safeParse({ ...value, module: "@pithy-sh/secrets/../../x" }).success).toBe(false);
    expect(TestBinding.safeParse({ ...value, module: '@pithy-sh/secrets/src/x"; evil("' }).success).toBe(false);
    expect(TestBinding.safeParse({ ...value, module: "@pithy-sh/secrets/src/x" }).success).toBe(true);
  });

  test("refuses an export that is not an identifier", () => {
    const value = { kind: "value", name: "KEY", module: "@pithy-sh/secrets/src/x" };
    expect(TestBinding.safeParse({ ...value, export: "dev key" }).success).toBe(false);
    expect(TestBinding.safeParse({ ...value, export: "devKey()" }).success).toBe(false);
  });

  test("holds a rate limiter to what Workers Rate Limiting accepts", () => {
    const limiter = { kind: "ratelimit", name: "LIMITER", limit: 10 };
    expect(TestBinding.safeParse({ ...limiter, period: 30 }).success).toBe(false);
    expect(TestBinding.safeParse({ ...limiter, period: 10 }).success).toBe(true);
    expect(TestBinding.safeParse({ ...limiter, limit: 0, period: 60 }).success).toBe(false);
  });
});

describe("testBindingKind", () => {
  test("names the kind a test config states each binding type with", () => {
    expect(testBindingKind("d1")).toBe("d1");
    expect(testBindingKind("kv")).toBe("kv");
    expect(testBindingKind("r2")).toBe("r2");
    expect(testBindingKind("ratelimit")).toBe("ratelimit");
    expect(testBindingKind("secret")).toBe("value");
  });

  test("leaves unbound what a test config cannot provide on its own", () => {
    for (const type of ["durable_object", "workflow", "vectorize", "ai", "artifacts"] as const) {
      expect(testBindingKind(type)).toBe("unbound");
    }
  });

  test("answers for every binding type", () => {
    for (const type of BindingType.options.map((option) => option.value)) {
      expect(TestBinding.options.map((option) => option.shape.kind.value)).toContain(testBindingKind(type));
    }
  });
});

describe("CapabilityManifest.testBindings", () => {
  const manifest = { name: "secrets", package: "@pithy-sh/secrets", requiredBindings: [] };

  test("reads the declaration", () => {
    const parsed = CapabilityManifest.parse({ ...manifest, testBindings: [{ kind: "d1", name: "SECRETS" }] });
    expect(parsed.testBindings).toEqual([{ kind: "d1", name: "SECRETS" }]);
  });

  test("defaults to none", () => {
    expect(CapabilityManifest.parse(manifest).testBindings).toEqual([]);
  });
});

describe("appliedTestBindings", () => {
  const controlplane = {
    requiredBindings: [
      { type: "d1" as const, name: "DB", optional: false },
      { type: "kv" as const, name: "CONTROL_PLANE", optional: true },
    ],
    testBindings: [
      { kind: "d1" as const, name: "DB" },
      { kind: "kv" as const, name: "CONTROL_PLANE" },
    ],
  };

  test("a binding the manifest requires always applies", () => {
    expect(appliedTestBindings(controlplane, undefined).map((binding) => binding.name)).toEqual(["DB"]);
  });

  test("an optional one applies when the composed capability requires it", () => {
    const kv = { requiredBindings: [{ type: "kv" as const, name: "CONTROL_PLANE" }] };
    expect(appliedTestBindings(controlplane, kv).map((binding) => binding.name)).toEqual(["DB", "CONTROL_PLANE"]);
  });

  test("and not when the composed capability lists it as optional too, or lists another binding of that name", () => {
    const optional = { requiredBindings: [{ type: "kv" as const, name: "CONTROL_PLANE", optional: true }] };
    const other = { requiredBindings: [{ type: "d1" as const, name: "CONTROL_PLANE" }] };
    expect(appliedTestBindings(controlplane, optional).map((binding) => binding.name)).toEqual(["DB"]);
    expect(appliedTestBindings(controlplane, other).map((binding) => binding.name)).toEqual(["DB"]);
  });
});
