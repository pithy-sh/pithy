// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineCapability } from "../capability/capability";
import { createBackend } from "../createBackend";
import { ValidationError } from "../error/pithyError";
import { secret } from "./classes";
import { blindIndex, encrypted, encryptedTable } from "./encrypted";
import { deriveEncryptedColumns, EncryptedColumnStamp, refuseEncryptedKvStores } from "./encryptedColumns";

function kvApp(value: z.ZodType) {
  return defineCapability({
    name: "app",
    requiredBindings: [],
    kvNamespaces: {
      cache: { binding: "CACHE", stores: { tokens: { prefix: "t", key: z.object({ id: z.string() }), value } } },
    },
  });
}

describe("deriveEncryptedColumns", () => {
  test("a newly marked field is stamped with no registration step", () => {
    const Visit = encryptedTable(z.object({ id: z.string(), note: z.string() }), { name: "visit", key: "id" });
    const app = (tables: Record<string, z.ZodType>) =>
      defineCapability({ name: "app", requiredBindings: [], databases: { app: { binding: "DB", tables } } });
    expect(deriveEncryptedColumns([app({ visits: Visit })]).columns).toEqual([]);
    const Marked = encryptedTable(Visit.extend({ note: encrypted(z.string()) }), { name: "visit", key: "id" });
    expect(deriveEncryptedColumns([app({ visits: Marked })]).columns.map((column) => column.path)).toEqual(["note"]);
  });

  test("refuses an encrypted table with no encryptedTable() declaration, naming the capability and table", () => {
    const Bare = z.object({ id: z.string(), note: encrypted(z.string()) });
    const app = defineCapability({
      name: "clinic",
      requiredBindings: [],
      databases: { app: { binding: "DB", tables: { visits: Bare } } },
    });
    expect(() => deriveEncryptedColumns([app])).toThrow(
      /clinic's app.visits table holds an encrypted field and declares no table/,
    );
  });

  test("refuses a table whose layout cannot be rotated", () => {
    const Broken = encryptedTable(z.object({ id: z.string(), orphan: blindIndex("nothing") }), {
      name: "b",
      key: "id",
    });
    const app = defineCapability({
      name: "clinic",
      requiredBindings: [],
      databases: { app: { binding: "DB", tables: { broken: Broken } } },
    });
    expect(() => deriveEncryptedColumns([app])).toThrow(ValidationError);
  });

  test("an encrypted field in KV is unrotatable, not stamped", () => {
    const stamp = deriveEncryptedColumns([kvApp(z.object({ token: encrypted(secret(z.string())) }))]);
    expect(stamp).toEqual({ columns: [], unread: [], unrotatable: ["app:cache.tokens:value.token"] });
    expect(EncryptedColumnStamp.parse(stamp)).toEqual(stamp);
  });

  test("the stamp refuses an identifier no SQL statement may carry", () => {
    const column = {
      name: "patient",
      path: "diagnosis",
      table: "patients; DROP TABLE x",
      column: "diagnosis",
      jsonPath: null,
      primaryKey: "id",
      binding: "DB",
      index: null,
    };
    expect(EncryptedColumnStamp.safeParse({ columns: [column], unread: [], unrotatable: [] }).success).toBe(false);
    expect(
      EncryptedColumnStamp.safeParse({
        columns: [{ ...column, table: "t", jsonPath: "$.a') --" }],
        unread: [],
        unrotatable: [],
      }).success,
    ).toBe(false);
  });
});

describe("the boot refusal on the KV registration path", () => {
  test.each([
    ["a field", z.object({ token: encrypted(z.string()) }), "value.token"],
    ["an optional field", z.object({ token: encrypted(z.string()).optional() }), "value.token"],
    ["a nullable field", z.object({ token: encrypted(z.string()).nullable() }), "value.token"],
    [
      "a defaulted object",
      z.object({ inner: z.object({ token: encrypted(z.string()) }).default({ token: {} as never }) }),
      "value.inner.token",
    ],
    ["a nested field", z.object({ a: z.object({ b: z.object({ token: encrypted(z.string()) }) }) }), "value.a.b.token"],
    ["the whole value", encrypted(z.string()), "value"],
  ])("refuses %s, naming the schema, the field and D1", (_label, value, path) => {
    expect(() => refuseEncryptedKvStores([kvApp(value)])).toThrow(
      new RegExp(
        `app's KV store cache\\.tokens holds an encrypted field at "${path.replace(/\./g, "\\.")}"\\. Encrypted fields rest in D1`,
      ),
    );
  });

  test("createBackend refuses it at assembly", () => {
    expect(() => createBackend({ capabilities: [kvApp(z.object({ token: encrypted(z.string()) }))] })).toThrow(
      /Encrypted fields rest in D1/,
    );
  });

  test("an unencrypted KV store boots", () => {
    expect(() => refuseEncryptedKvStores([kvApp(z.object({ token: secret(z.string()) }))])).not.toThrow();
  });
});
