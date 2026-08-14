// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { masterKeyRegistryEntry } from "../capability";
import type { EncryptionConfig } from "../crypto/envelope";
import { VersionedValue } from "../crypto/versionedValue";
import { MASTER_KEY_BINDING } from "../env/bindings";
import { defineSecretRegistry, type SecretRegistry, type SecretRegistryEntry } from "../registry";
import { initialDevSecret } from "./devSecretsFile";
import { loadDevSecrets } from "./loadDevSecrets";
import { devSecretPayload, migrateDevSecrets } from "./seedDevSecrets";

/**
 * **The rule the dev secrets file exists to keep (#323): a secret's entry is the precise payload its
 * destination receives. Nothing wraps it, nothing unwraps it, and no secret is an exception.**
 *
 * Asked of every secret in the registry rather than of the one this issue was about. `SECRETS_ENCRYPTION_KEYS`
 * was wrong *because* it was the exception — the one secret whose payload is itself a versioned structure —
 * and a test written for it alone would have been written to match whatever it did. A gate over the whole
 * population asks eight secrets one question and finds the one that answers differently.
 */

/** One secret in the population: its registry entry, and a value that satisfies what the entry declares. */
interface Population {
  readonly name: string;
  readonly entry: SecretRegistryEntry;
  /** A value of this secret's declared type — the thing a mint or a hand-edit puts in the file. */
  readonly value: unknown;
}

const CONFIG: EncryptionConfig = {
  currentVersion: "1",
  versions: { "1": "a2V5LW1hdGVyaWFs" },
  lastRotatedAt: "2026-08-06T16:21:53.830Z",
};

/**
 * Every axis a payload's shape could turn on, crossed — plus the real `masterKeyRegistryEntry`, so the
 * one secret this issue is about is judged as the kit actually declares it rather than as a copy.
 */
const population: readonly Population[] = [
  {
    name: "auth-session-secret",
    entry: { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
    value: "s3ss10n",
  },
  {
    name: "auth-google-credentials",
    entry: {
      backend: "d1",
      scope: "environment",
      rotatable: false,
      valueType: "json",
      schema: z
        .object({
          clientId: z.string().describe("The OAuth client id."),
          clientSecret: z.string().describe("The OAuth client secret."),
        })
        .describe("Google OAuth credentials."),
    },
    value: { clientId: "id.apps.googleusercontent.com", clientSecret: "shh" },
  },
  {
    name: "connection-key-encryption-key",
    entry: { backend: "cf-secrets-store", scope: "global", rotatable: true, valueType: "text" },
    value: "a2V5",
  },
  {
    name: "payments-provider-credentials",
    entry: {
      backend: "cf-secrets-store",
      scope: "environment",
      rotatable: false,
      valueType: "json",
      schema: z.object({ apiKey: z.string().describe("The rail's API key.") }).describe("Payment rail credentials."),
    },
    value: { apiKey: "sk_test" },
  },
  { name: MASTER_KEY_BINDING, entry: masterKeyRegistryEntry, value: CONFIG },
];

const registry: SecretRegistry = defineSecretRegistry(
  Object.fromEntries(population.map(({ name, entry }) => [name, entry])),
);

/** The file this population produces, written the one way a writer is allowed to write it. */
function stateAll(): Record<string, unknown> {
  return Object.fromEntries(population.map(({ name, entry, value }) => [name, initialDevSecret(entry, value)]));
}

/** How many times `key` appears as an object key anywhere in `value`. A wrapper is one extra occurrence. */
function occurrences(value: unknown, key: string): number {
  if (Array.isArray(value)) return value.reduce<number>((total, item) => total + occurrences(item, key), 0);
  if (value === null || typeof value !== "object") return 0;
  return Object.entries(value).reduce((total, [k, v]) => total + (k === key ? 1 : 0) + occurrences(v, key), 0);
}

/**
 * The destination's value, parsed back into structure — so it can be compared with the file's entry
 * rather than with a string. A `text` payload is its own value and parses no further.
 */
function received(entry: SecretRegistryEntry, name: string, stated: unknown): unknown {
  const text = devSecretPayload(entry, name, stated).text;
  return entry.bootstrap === true && entry.valueType === "text" ? text : JSON.parse(text);
}

describe("the population this rule is asked of", () => {
  // A gate over a set that happens to be uniform proves nothing about a rule whose whole subject is a
  // secret that differs. This is the floor: the axes the payload could turn on are all represented, and
  // both sides of the one that it does turn on are.
  test("covers every axis a payload's shape could turn on, and both sides of the one it does", () => {
    const entries = population.map(({ entry }) => entry);

    expect(new Set(entries.map((entry) => entry.backend))).toEqual(new Set(["d1", "cf-secrets-store"]));
    expect(new Set(entries.map((entry) => entry.valueType))).toEqual(new Set(["text", "json"]));
    expect(new Set(entries.map((entry) => entry.scope))).toEqual(new Set(["environment", "global"]));
    expect(entries.filter((entry) => entry.bootstrap === true)).toHaveLength(1);
    expect(entries.filter((entry) => entry.bootstrap !== true).length).toBeGreaterThan(1);
  });

  test("the bootstrap entry is the kit's own, not a copy of it", () => {
    expect(registry[MASTER_KEY_BINDING]).toBe(masterKeyRegistryEntry);
  });
});

describe("a secret's entry is the payload its destination receives", () => {
  const stated = stateAll();

  for (const { name, entry } of population) {
    test(`${name}: what the file states is what the destination gets`, () => {
      // The whole rule, per secret. The only difference allowed between the two is that a `json` value is
      // written as its own structure in the file and serialized on the wire — a JSON-in-JSON concession
      // for the person editing it, which parsing back undoes. Anything else is a wrapper.
      expect(received(entry, name, stated[name])).toEqual(reparsed(entry, stated[name]));
    });

    test(`${name}: currentVersion appears exactly once in what the file states`, () => {
      // The observable symptom of a wrapper, and the assertion that would have caught this entry on the
      // day it was written. One concept, one pointer: an envelope has one, an `EncryptionConfig` has one,
      // and an envelope around an `EncryptionConfig` has two for the same concept.
      expect(occurrences(stated[name], "currentVersion")).toBe(1);
    });

    test(`${name}: what the destination receives is what its own reader accepts`, () => {
      // The consequence, from the far end. `resolveEncryptionConfig` parses the master key's binding as
      // an `EncryptionConfig` and the store parses every other value as a `VersionedValue`; a payload
      // wrapped on the way out is a Worker that fails at its first read with the binding plainly present.
      expect(() => readsBack(entry, devSecretPayload(entry, name, stated[name]).text)).not.toThrow();
    });
  }

  test("what every writer produces is what the reader accepts", () => {
    expect(() => loadDevSecrets(JSON.stringify(stated), { registry })).not.toThrow();
  });

  test("a file the writer produced needs no migration — the two halves agree", () => {
    expect(migrateDevSecrets(loadDevSecrets(JSON.stringify(stated), { registry }), registry)).toEqual({});
  });
});

/**
 * The value at the destination, read the way the code that reads it there reads it. Throws when it will
 * not read — which is the whole failure mode a wrapper produces, arriving where it actually bites.
 */
function readsBack(entry: SecretRegistryEntry, text: string): void {
  if (entry.bootstrap === true) {
    if (entry.valueType === "json") entry.schema.parse(JSON.parse(text));
    return;
  }
  const envelope = VersionedValue.parse(JSON.parse(text));
  if (entry.valueType === "text") return;
  for (const version of Object.values(envelope.versions)) entry.schema.parse(JSON.parse(version));
}

/**
 * The file's `json` widening undone: each version's structure, as the destination's serialized form parses
 * back to. Written from the format's own documentation rather than from the reader, so the two are not one
 * implementation asserting against itself.
 */
function reparsed(entry: SecretRegistryEntry, stated: unknown): unknown {
  if (entry.bootstrap === true) return stated;
  const envelope = stated as { currentVersion: string; versions: Record<string, unknown> };
  const versions = Object.fromEntries(
    Object.entries(envelope.versions).map(([version, value]) => [
      version,
      entry.valueType === "text" ? value : JSON.stringify(value),
    ]),
  );
  return { currentVersion: envelope.currentVersion, versions };
}

describe("the upgrade off the old wrapped shape", () => {
  /** The file as a pithy older than #323 wrote it: the bootstrap payload inside an envelope. */
  const wrapped = { ...stateAll(), [MASTER_KEY_BINDING]: { currentVersion: "1", versions: { "1": CONFIG } } };

  test("it still reads, so a project that has not upgraded is not broken by a newer reader", () => {
    const file = loadDevSecrets(JSON.stringify(wrapped), { registry });

    expect(devSecretPayload(masterKeyRegistryEntry, MASTER_KEY_BINDING, file[MASTER_KEY_BINDING]).payload).toEqual(
      CONFIG,
    );
  });

  test("the binding it produces is the same string either shape states", () => {
    // The upgrade changes the file and not what a Worker receives. If these differed, migrating would be
    // a key rotation, and a key rotation on this secret orphans every secret encrypted under the old one.
    const old = devSecretPayload(masterKeyRegistryEntry, MASTER_KEY_BINDING, wrapped[MASTER_KEY_BINDING]).text;
    const now = devSecretPayload(masterKeyRegistryEntry, MASTER_KEY_BINDING, stateAll()[MASTER_KEY_BINDING]).text;

    expect(old).toBe(now);
  });

  test("it is offered for migration, and nothing else in the file is", () => {
    expect(migrateDevSecrets(loadDevSecrets(JSON.stringify(wrapped), { registry }), registry)).toEqual({
      [MASTER_KEY_BINDING]: CONFIG,
    });
  });

  test("migrating twice is migrating once — the second run finds nothing to do", () => {
    const first = migrateDevSecrets(loadDevSecrets(JSON.stringify(wrapped), { registry }), registry);

    expect(migrateDevSecrets({ ...wrapped, ...first }, registry)).toEqual({});
  });

  test("a bare payload that will not read names no version, because it has none", () => {
    // The legibility rule this issue also carries: the message an adopter gets must describe the file
    // in front of them. "failed validation at version '1'" sends somebody hunting for a key their entry
    // does not contain — and the entry has no versions, by design.
    const broken = { currentVersion: "1", versions: { "1": "a2V5" } };
    const thrown = (() => {
      try {
        devSecretPayload(masterKeyRegistryEntry, MASTER_KEY_BINDING, broken, "/tmp/secrets.jsonc");
      } catch (error) {
        return error as PithyError;
      }
      throw new Error("expected a refusal");
    })();

    expect(thrown.payload.message).toContain(MASTER_KEY_BINDING);
    expect(thrown.payload.message).toContain("/tmp/secrets.jsonc");
    expect(thrown.payload.message).not.toContain("version");
    expect(JSON.stringify(thrown.payload)).not.toContain("a2V5");
  });

  test("a secret whose value is legitimately an envelope is never unwrapped out from under itself", () => {
    // The reason the reader asks the registry's schema *first*. A `bootstrap` secret declared over a
    // schema shaped like an envelope would otherwise be migrated into its own current version — a value
    // nothing can put back, on the one secret whose loss makes every other secret unreadable.
    const envelopeShaped = defineSecretRegistry({
      "odd-bootstrap": {
        backend: "cf-secrets-store",
        scope: "environment",
        rotatable: false,
        bootstrap: true,
        valueType: "json",
        schema: z
          .object({
            currentVersion: z.string().describe("Looks like an envelope pointer, and is this value's own."),
            versions: z.record(z.string(), z.string()).describe("Looks like an envelope map, and is this value's own."),
          })
          .describe("A payload structurally identical to an envelope."),
      },
    });
    const own = { currentVersion: "1", versions: { "1": "mine" } };

    expect(migrateDevSecrets({ "odd-bootstrap": own }, envelopeShaped)).toEqual({});
  });
});
