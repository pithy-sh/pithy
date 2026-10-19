// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { VersionedValue } from "../crypto/versionedValue";
import { decodeVersionedValue, encodeVersionedValue, initialVersionedValue } from "../crypto/versionedValue";
import { SecretNotFoundError } from "../error/errors";
import { envelopeVersionStore, secretsStoreVersionStore } from "./versionStore";

/** One envelope per name, in memory, with every write counted. */
function memory(initial: Record<string, VersionedValue>) {
  const held = new Map(Object.entries(initial));
  let writes = 0;
  return {
    held,
    writes: () => writes,
    store: envelopeVersionStore({
      read: async (name) => held.get(name),
      write: async (name, value) => {
        writes += 1;
        held.set(name, value);
      },
    }),
  };
}

describe("envelopeVersionStore", () => {
  test("append makes the successor current and names the versions it overlaps", async () => {
    const { held, store } = memory({ key: initialVersionedValue("a") });
    expect(await store.append("key", "b")).toEqual({ version: "2", prior: ["1"] });
    expect(held.get("key")).toEqual({ currentVersion: "2", versions: { "1": "a", "2": "b" } });
  });

  test("append is idempotent on the value: a retried store writes nothing twice", async () => {
    const { store, writes } = memory({ key: initialVersionedValue("a") });
    await store.append("key", "b");
    expect(await store.append("key", "b")).toEqual({ version: "2", prior: ["1"] });
    expect(writes()).toBe(1);
  });

  test("append refuses a name with nothing stored, rather than inventing a version 1", async () => {
    const { store } = memory({});
    await expect(store.append("key", "b")).rejects.toThrow(SecretNotFoundError);
  });

  test("retire drops the prior versions, keeps the current one, and reports what is left", async () => {
    const { held, store } = memory({ key: { currentVersion: "2", versions: { "1": "a", "2": "b" } } });
    expect(await store.retire("key", ["1", "2"])).toEqual({ current: "2", versions: ["2"] });
    expect(held.get("key")).toEqual({ currentVersion: "2", versions: { "2": "b" } });
  });

  test("retire is idempotent: a version already gone writes nothing", async () => {
    const { store, writes } = memory({ key: { currentVersion: "2", versions: { "2": "b" } } });
    expect(await store.retire("key", ["1"])).toEqual({ current: "2", versions: ["2"] });
    expect(writes()).toBe(0);
  });

  test("versions names version keys and never a value", async () => {
    const { store } = memory({ key: { currentVersion: "2", versions: { "1": "a", "2": "b" } } });
    expect(await store.versions("key")).toEqual({ current: "2", versions: ["1", "2"] });
    expect(await store.versions("absent")).toBeUndefined();
  });
});

describe("secretsStoreVersionStore — a Secrets Store entry, read through its binding and written over REST", () => {
  test("reads the envelope off the binding and writes the whole envelope back to the entry", async () => {
    const entries = new Map([["acme-prod-email-link-signing-key", encodeVersionedValue(initialVersionedValue("a"))]]);
    const store = secretsStoreVersionStore({
      read: async (name) =>
        name === "email-link-signing-key" ? entries.get("acme-prod-email-link-signing-key") : undefined,
      write: async (name, text) => {
        expect(name).toBe("email-link-signing-key");
        entries.set("acme-prod-email-link-signing-key", text);
      },
    });
    expect(await store.append("email-link-signing-key", "b")).toEqual({ version: "2", prior: ["1"] });
    expect(decodeVersionedValue(entries.get("acme-prod-email-link-signing-key") as string)).toEqual({
      currentVersion: "2",
      versions: { "1": "a", "2": "b" },
    });
  });
});
