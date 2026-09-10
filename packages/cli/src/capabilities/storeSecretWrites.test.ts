// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { backendRoutedDispatcher, type PreflightSecretDispatcher } from "@pithy-sh/secrets/src/cli/dispatch";
import { EncryptionConfig } from "@pithy-sh/secrets/src/crypto/envelope";
import { encodeVersionedValue, initialVersionedValue } from "@pithy-sh/secrets/src/crypto/versionedValue";
import { resolveEncryptionConfig, type SecretsStoreEnv } from "@pithy-sh/secrets/src/env/bindings";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/masterKeyBinding";
import { SecretCryptoError } from "@pithy-sh/secrets/src/error/errors";
import { initialMasterKeyConfig } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { defineSecretRegistry, type SecretRegistry } from "@pithy-sh/secrets/src/registry";
import type { ManagedEnvironment } from "@pithy-sh/secrets/src/scope";
import { describe, expect, test } from "vitest";
import type { SecretsStore } from "../provision/store";
import { runSecretWrite } from "./secrets";
import { storeSecretWriter } from "./storeSecretWrites";

/**
 * # A bootstrap secret is written raw, and the proof is a boot reader parsing it (#517)
 *
 * `storeSecretWriter` composed `encodeVersionedValue(initialVersionedValue(value))` for every request.
 * That is right for every secret whose reader decodes an envelope, and wrong at the root for a
 * `bootstrap` one: a `bootstrap` secret is *defined* as one read before the store that decoder needs is
 * open. `resolveEncryptionConfig` is that reader — it takes the binding's plaintext, `JSON.parse`s it
 * and parses an `EncryptionConfig` — so an envelope around the value is a value it cannot parse, and the
 * only thing the Worker can say about it is `SECRETS_ENCRYPTION_KEYS is not a valid EncryptionConfig`,
 * at its first request, over a value `pithy secrets create` reported as written.
 *
 * `#323` settled the identical question one destination over and stated the rule generally: **the file
 * states the payload the destination receives.** A store entry is a destination.
 *
 * ## Why this file proves it with a reader rather than with a shape
 *
 * Every previous test on this surface asserted the *stored string*, which is how the envelope survived:
 * `{ currentVersion, versions }` around an `EncryptionConfig` is well-formed JSON containing the value,
 * and a test comparing it against what the writer composed agrees with the writer by construction. So
 * the assertion here is the far end — the real `resolveEncryptionConfig`, over a binding holding exactly
 * what the real write path put in the account's store. It fails on an envelope and it cannot be made to
 * pass by agreeing with the writer.
 *
 * ## The master key itself is not what is written, and that is not a dodge
 *
 * `assertNotTheMasterKey` refuses `SECRETS_ENCRYPTION_KEYS` in every mode, before a value is even asked
 * for — provisioning creates it, and replacing it orphans every secret sealed under it. An adopter's own
 * `bootstrap` entry is a shape `defineSecretRegistry` accepts and nothing creates, which is one of the
 * cells #517 exists for. It is written here under its own name and then read by the master key's own
 * reader, because that reader *is* the boot-time direct-binding read this axis describes, and the two
 * values are the same shape by construction: `initialMasterKeyConfig` composes it.
 */

const PROJECT = "replay";
const ENVIRONMENTS = ["staging", "prod"] as const;

/**
 * An adopter's own bootstrap secret, holding the one payload the kit has a real boot reader for.
 * Declared through the real `defineSecretRegistry`, so the shape is one the author-time rules accept.
 */
const REGISTRY: SecretRegistry = defineSecretRegistry({
  APP_ENCRYPTION_KEYS: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: false,
    valueType: "json",
    schema: EncryptionConfig,
    bootstrap: true,
  },
  APP_WEBHOOK_SECRET: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: false,
    valueType: "text",
  },
}) as SecretRegistry;

/** The account's one Secrets Store, entry name to stored payload. */
function recordingStore(entries: Map<string, string>): SecretsStore {
  return {
    storeId: "store-1",
    exists: async (name) => entries.has(name),
    put: async (name, value) => {
      entries.set(name, value);
    },
    remove: async (name) => entries.delete(name),
  };
}

/** A manager that refuses everything: no case here is a `d1` write, and one arriving would be the bug. */
const NO_D1: PreflightSecretDispatcher = {
  dispatch: async () => {
    throw new Error("a d1 write was dispatched by a test about store entries");
  },
  preflight: async () => {
    throw new Error("a d1 pre-flight was asked by a test about store entries");
  },
};

/** The whole write path of `pithy secrets create|update`, from the command's brain to the account. */
async function pithySecretsCreate(
  entries: Map<string, string>,
  name: string,
  value: string,
  mode: "create" | "update" = "create",
): Promise<void> {
  const routed = backendRoutedDispatcher({
    d1: NO_D1,
    "cf-secrets-store": storeSecretWriter({
      store: async () => recordingStore(entries),
      scope: (env) => environmentScope(PROJECT, env),
    }),
  });
  await runSecretWrite(REGISTRY, routed, {
    mode,
    name,
    value,
    env: "prod" as ManagedEnvironment,
    environments: [...ENVIRONMENTS],
  });
}

/** The entry name provisioning will ask the store for — composed the way the writer composes it. */
function entryName(name: string): string {
  return environmentScope(PROJECT, "prod").secretEntry(name, "environment");
}

/**
 * **The Worker's own env, holding exactly what the account holds.**
 *
 * A deployed `secrets_store_secrets` binding resolves to the entry's plaintext, so `.get()` returns the
 * stored string verbatim. `SECRETS` is never reached: `resolveEncryptionConfig` runs before any store is
 * open, which is the whole of why a `bootstrap` secret carries no envelope.
 */
function workerEnv(stored: string): SecretsStoreEnv {
  return {
    SECRETS: null as unknown as D1Database,
    [MASTER_KEY_BINDING]: { get: async () => stored },
  };
}

describe("a bootstrap secret's entry is the value its binding carries", () => {
  test("the real boot reader parses what the real write path stored", async () => {
    const entries = new Map<string, string>();
    const config = await initialMasterKeyConfig();

    await pithySecretsCreate(entries, "APP_ENCRYPTION_KEYS", JSON.stringify(config));

    const stored = entries.get(entryName("APP_ENCRYPTION_KEYS"));
    expect(stored, "the value did not reach the account's store").toBeTypeOf("string");
    // The far end, and the only assertion that settles the envelope question: a Worker booting against
    // this entry gets the config back, key for key.
    expect(await resolveEncryptionConfig(workerEnv(stored as string))).toEqual(config);
  });

  /**
   * **The shape the writer used to produce, put through the same reader.** It is well-formed JSON that
   * contains the value, which is exactly why asserting on the stored string never caught it — and it is
   * a Worker that will not boot.
   */
  test("the enveloped shape is what that reader refuses", async () => {
    const config = await initialMasterKeyConfig();
    const enveloped = encodeVersionedValue(initialVersionedValue(JSON.stringify(config)));
    await expect(resolveEncryptionConfig(workerEnv(enveloped))).rejects.toBeInstanceOf(SecretCryptoError);
  });

  /** And an update replaces it in place, still raw — a rotation of this value is a rotation inside it. */
  test("an update leaves the entry readable", async () => {
    const entries = new Map<string, string>();
    await pithySecretsCreate(entries, "APP_ENCRYPTION_KEYS", JSON.stringify(await initialMasterKeyConfig()));
    const next = await initialMasterKeyConfig();
    await pithySecretsCreate(entries, "APP_ENCRYPTION_KEYS", JSON.stringify(next), "update");

    expect(await resolveEncryptionConfig(workerEnv(entries.get(entryName("APP_ENCRYPTION_KEYS")) as string))).toEqual(
      next,
    );
  });

  /**
   * **The other side of the axis, so this is a rule and not an exemption.** An ordinary secret in the
   * same registry, written by the same command through the same writer, still gets the envelope every
   * reader of this backend decodes — which is what makes a value rotation expressible at all.
   */
  test("an ordinary secret beside it is still enveloped", async () => {
    const entries = new Map<string, string>();
    await pithySecretsCreate(entries, "APP_WEBHOOK_SECRET", "the-value-the-operator-holds");
    expect(JSON.parse(entries.get(entryName("APP_WEBHOOK_SECRET")) as string)).toEqual({
      currentVersion: "1",
      versions: { "1": "the-value-the-operator-holds" },
    });
  });
});

/**
 * # The refusals a store write owns, asked with nothing written (#517)
 *
 * `pithy secrets rotate` calls a third party's API and then stores what comes back, so a refusal reached
 * at the store is a refusal reached after the credential is dead at its issuer. Both of this writer's
 * refusals are facts about the destination and knowable in advance, so `preflight` asks them — and
 * `dispatch` asks them again, which is what keeps them a guarantee rather than a courtesy.
 */
describe("preflight", () => {
  /** The pair the routed dispatcher composes, over a store that may or may not be reachable. */
  function writer(entries: Map<string, string> | null): PreflightSecretDispatcher {
    return storeSecretWriter({
      store: async () => {
        if (entries === null) throw new Error("SECRETS_STORE_ID is not set");
        return recordingStore(entries);
      },
      scope: (env) => environmentScope(PROJECT, env),
    });
  }

  const update = {
    env: "prod" as ManagedEnvironment,
    mode: "update" as const,
    name: "APP_WEBHOOK_SECRET",
    backend: "cf-secrets-store" as const,
    scope: "environment" as const,
    bootstrap: false,
    valueType: "text" as const,
    rotatable: false,
  };

  test("an unreachable store is refused before anything is written", async () => {
    await expect(writer(null).preflight(update)).rejects.toThrow(/SECRETS_STORE_ID/);
  });

  test("an update of an entry that is not there is refused", async () => {
    await expect(writer(new Map()).preflight(update)).rejects.toThrow(/does not exist/);
  });

  test("an update of a live entry passes, and writes nothing", async () => {
    const entries = new Map<string, string>();
    await pithySecretsCreate(entries, "APP_WEBHOOK_SECRET", "first");
    const before = new Map(entries);

    await expect(writer(entries).preflight(update)).resolves.toBeUndefined();

    expect([...entries]).toEqual([...before]);
  });

  /** A create is the mirror: what it refuses is an entry that is already live. */
  test("a create over a live entry is refused", async () => {
    const entries = new Map<string, string>();
    await pithySecretsCreate(entries, "APP_WEBHOOK_SECRET", "first");
    await expect(writer(entries).preflight({ ...update, mode: "create" })).rejects.toThrow(/already exists/);
  });
});
