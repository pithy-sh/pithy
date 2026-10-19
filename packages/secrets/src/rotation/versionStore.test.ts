// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { VersionedValue } from "../crypto/versionedValue";
import { decodeVersionedValue, encodeVersionedValue, initialVersionedValue } from "../crypto/versionedValue";
import { SecretNotFoundError } from "../error/errors";
import { versionFingerprint } from "./reencryption";
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
  test("stage adds the successor beside the current version, which stays current", async () => {
    const { held, store } = memory({ key: initialVersionedValue("a") });
    expect(await store.stage("key", "b")).toEqual({
      version: "2",
      fingerprint: await versionFingerprint("b"),
      prior: ["1"],
    });
    expect(held.get("key")).toEqual({ currentVersion: "1", versions: { "1": "a", "2": "b" } });
  });

  test("stage is idempotent on the value: a retried store writes nothing twice", async () => {
    const { store, writes } = memory({ key: initialVersionedValue("a") });
    const once = await store.stage("key", "b");
    expect(await store.stage("key", "b")).toEqual(once);
    expect(writes()).toBe(1);
  });

  test("stage refuses a name with nothing stored, rather than inventing a version 1", async () => {
    const { store } = memory({});
    await expect(store.stage("key", "b")).rejects.toThrow(SecretNotFoundError);
  });

  test("promote makes the staged version current, once", async () => {
    const { held, store, writes } = memory({ key: initialVersionedValue("a") });
    const staged = await store.stage("key", "b");
    expect(await store.promote("key", staged)).toBe(true);
    expect(held.get("key")).toEqual({ currentVersion: "2", versions: { "1": "a", "2": "b" } });
    expect(await store.promote("key", staged)).toBe(true);
    expect(writes()).toBe(2);
  });

  test("promote refuses a version an update has since replaced, whatever its key says", async () => {
    const { held, store } = memory({ key: initialVersionedValue("a") });
    const staged = await store.stage("key", "b");
    held.set("key", { currentVersion: "1", versions: { "1": "pasted", "2": "another" } });
    expect(await store.promote("key", staged)).toBe(false);
    expect(held.get("key")?.currentVersion).toBe("1");
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

  test("fingerprints names each version by its key-check value, never by its value", async () => {
    const { store } = memory({ key: { currentVersion: "2", versions: { "1": "a", "2": "b" } } });
    const fingerprints = await store.fingerprints("key");
    expect(fingerprints).toEqual({ "1": await versionFingerprint("a"), "2": await versionFingerprint("b") });
    expect(Object.values(fingerprints ?? {})).not.toContain("a");
    expect(await store.fingerprints("absent")).toBeUndefined();
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
    await store.promote("email-link-signing-key", await store.stage("email-link-signing-key", "b"));
    expect(decodeVersionedValue(entries.get("acme-prod-email-link-signing-key") as string)).toEqual({
      currentVersion: "2",
      versions: { "1": "a", "2": "b" },
    });
  });
});
