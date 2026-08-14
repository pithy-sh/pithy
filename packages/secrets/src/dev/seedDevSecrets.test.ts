// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { encodeVersionedValue, type VersionedValue } from "../crypto/versionedValue";
import { defineSecretRegistry, type SecretValueType } from "../registry";
import { DevSecretEnvelope, type DevSecretsFile } from "./devSecretsFile";
import { type DevSecretsStore, devVarsForRegistry, mintMissingDevSecrets, seedDevSecrets } from "./seedDevSecrets";

/** An in-memory stand-in for the `SECRETS` D1 store, counting writes so idempotency is observable. */
class FakeStore implements DevSecretsStore {
  readonly rows = new Map<string, { value: VersionedValue; valueType: SecretValueType }>();
  writes = 0;

  async getValue(name: string): Promise<VersionedValue | undefined> {
    return this.rows.get(name)?.value;
  }

  async put(name: string, value: VersionedValue, valueType: SecretValueType): Promise<void> {
    this.writes += 1;
    this.rows.set(name, { value, valueType });
  }
}

const GOOGLE = z
  .object({
    clientId: z.string().describe("The OAuth client id."),
    clientSecret: z.string().describe("The OAuth client secret."),
  })
  .describe("A Google OAuth application's credentials.");

const registry = defineSecretRegistry({
  "auth-session-secret": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
  "auth-google-credentials": {
    backend: "d1",
    scope: "environment",
    rotatable: false,
    valueType: "json",
    schema: GOOGLE,
  },
  CLOUDFLARE_API_TOKEN: { backend: "cf-secrets-store", scope: "global", rotatable: true, valueType: "text" },
  CONNECTION_SIGNING_KEY: { backend: "d1", scope: "environment", rotatable: true, valueType: "text", keyed: true },
});

/** The thrown payload — every failure names the secret in `message`, never the value. */
async function payload(fn: () => Promise<unknown>): Promise<PithyError["payload"]> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PithyError) return error.payload;
    throw error;
  }
  throw new Error("expected a PithyError");
}

describe("seedDevSecrets — the registry decides the destination", () => {
  test("a d1 secret becomes an encrypted row, in the shape a provisioned secret has", async () => {
    const store = new FakeStore();
    const file: DevSecretsFile = { "auth-session-secret": { currentVersion: "1", versions: { "1": "abc" } } };

    const result = await seedDevSecrets({ file, registry, store });

    expect(result.seeded).toEqual(["auth-session-secret"]);
    expect(store.rows.get("auth-session-secret")).toEqual({
      value: { currentVersion: "1", versions: { "1": "abc" } },
      valueType: "text",
    });
  });

  test("a json secret's own object is serialized to the canonical string the store holds", async () => {
    const store = new FakeStore();
    const credentials = { clientId: "id", clientSecret: "shh" };
    const file: DevSecretsFile = { "auth-google-credentials": { currentVersion: "1", versions: { "1": credentials } } };

    await seedDevSecrets({ file, registry, store });

    expect(store.rows.get("auth-google-credentials")).toEqual({
      value: { currentVersion: "1", versions: { "1": JSON.stringify(credentials) } },
      valueType: "json",
    });
  });

  test("a cf-secrets-store secret is never written to D1 — it comes back as a .dev.vars line", async () => {
    const store = new FakeStore();
    const cfOnly = defineSecretRegistry({
      CLOUDFLARE_API_TOKEN: { backend: "cf-secrets-store", scope: "global", rotatable: true, valueType: "text" },
    });
    const file: DevSecretsFile = { CLOUDFLARE_API_TOKEN: { currentVersion: "1", versions: { "1": "cf-token" } } };

    const result = await seedDevSecrets({ file, registry: cfOnly, store });

    expect(store.writes).toBe(0);
    expect(result.seeded).toEqual([]);
    expect(result.devVars).toEqual({
      CLOUDFLARE_API_TOKEN: encodeVersionedValue({ currentVersion: "1", versions: { "1": "cf-token" } }),
    });
  });

  test("every still-valid version is carried through, pointer included", async () => {
    const store = new FakeStore();
    const file: DevSecretsFile = { "auth-session-secret": { currentVersion: "2", versions: { "1": "a", "2": "b" } } };

    await seedDevSecrets({ file, registry, store });

    expect(store.rows.get("auth-session-secret")?.value).toEqual({
      currentVersion: "2",
      versions: { "1": "a", "2": "b" },
    });
  });
});

describe("seedDevSecrets — minting", () => {
  test("a devValue secret absent from the file is minted, seeded, and returned for write-back", async () => {
    const store = new FakeStore();

    const result = await seedDevSecrets({ file: {}, registry, store });

    const minted = DevSecretEnvelope.parse(result.minted["auth-session-secret"]);
    expect(minted.currentVersion).toBe("1");
    expect(typeof minted.versions["1"]).toBe("string");
    expect(result.seeded).toEqual(["auth-session-secret"]);
    expect(store.rows.get("auth-session-secret")?.value).toEqual(minted);
  });

  test("a secret already in the file is never minted — a new value invalidates what the old one signed", async () => {
    const store = new FakeStore();
    const file: DevSecretsFile = { "auth-session-secret": { currentVersion: "1", versions: { "1": "kept" } } };

    const result = await seedDevSecrets({ file, registry, store });

    expect(result.minted).toEqual({});
    expect(store.rows.get("auth-session-secret")?.value.versions["1"]).toBe("kept");
  });

  test("a secret with no devValue and no file entry is reported, not invented", async () => {
    const store = new FakeStore();

    const result = await seedDevSecrets({ file: {}, registry, store });

    expect(result.missing).toEqual(["CLOUDFLARE_API_TOKEN", "auth-google-credentials"]);
    expect(result.minted["auth-google-credentials"]).toBeUndefined();
  });
});

describe("seedDevSecrets — idempotent", () => {
  test("re-running writes nothing and rotates nothing", async () => {
    const store = new FakeStore();
    const first = await seedDevSecrets({ file: {}, registry, store });
    const file: DevSecretsFile = { ...first.minted };
    const writesAfterFirst = store.writes;

    const second = await seedDevSecrets({ file, registry, store });

    expect(second.minted).toEqual({});
    expect(second.seeded).toEqual([]);
    expect(second.unchanged).toEqual(["auth-session-secret"]);
    expect(store.writes).toBe(writesAfterFirst);
    expect(store.rows.get("auth-session-secret")?.value).toEqual(first.minted["auth-session-secret"]);
  });

  test("an edited value does reach the store — unchanged means unchanged, not untouched", async () => {
    const store = new FakeStore();
    await seedDevSecrets({
      file: { "auth-session-secret": { currentVersion: "1", versions: { "1": "old" } } },
      registry,
      store,
    });

    const result = await seedDevSecrets({
      file: { "auth-session-secret": { currentVersion: "1", versions: { "1": "new" } } },
      registry,
      store,
    });

    expect(result.seeded).toEqual(["auth-session-secret"]);
    expect(store.rows.get("auth-session-secret")?.value.versions["1"]).toBe("new");
  });
});

describe("seedDevSecrets — the file and the registry cannot disagree", () => {
  test("a json value failing its registry schema names the secret and never echoes the value", async () => {
    const store = new FakeStore();
    const file: DevSecretsFile = {
      "auth-google-credentials": { currentVersion: "1", versions: { "1": { clientId: "id", clientSecret: 7 } } },
    };

    const result = await payload(() => seedDevSecrets({ file, registry, store }));

    expect(result.code).toBe("validation/invalid_input");
    expect(result.message).toContain("auth-google-credentials");
    expect(JSON.stringify(result)).not.toContain('"id"');
  });

  test("a text value that is not a string names the secret and the version", async () => {
    const store = new FakeStore();
    const file: DevSecretsFile = { "auth-session-secret": { currentVersion: "1", versions: { "1": { a: 1 } } } };

    const result = await payload(() => seedDevSecrets({ file, registry, store }));

    expect(result.message).toContain("auth-session-secret");
  });

  test("a keyspace named in the file is refused — its members are written by the app at runtime", async () => {
    const store = new FakeStore();
    const file: DevSecretsFile = { CONNECTION_SIGNING_KEY: { currentVersion: "1", versions: { "1": "k" } } };

    const result = await payload(() => seedDevSecrets({ file, registry, store }));

    expect(result.message).toContain("CONNECTION_SIGNING_KEY");
  });

  test("a keyspace is not reported missing — it has no one value to seed", async () => {
    const result = await seedDevSecrets({ file: {}, registry, store: new FakeStore() });

    expect(result.missing).not.toContain("CONNECTION_SIGNING_KEY");
  });

  test("a name no capability declares is reported, not thrown — removing a capability must not brick dev", async () => {
    const store = new FakeStore();
    const file: DevSecretsFile = { "gone-capability-secret": { currentVersion: "1", versions: { "1": "v" } } };

    const result = await seedDevSecrets({ file, registry: defineSecretRegistry({}), store });

    expect(result.undeclared).toEqual(["gone-capability-secret"]);
    expect(store.writes).toBe(0);
  });

  test("a name matching an Object.prototype key is undeclared like any other", async () => {
    // `name in registry` walked the prototype chain, so a stale `toString` in the file read as
    // declared by every capability and was silently never reported.
    const store = new FakeStore();
    const file: DevSecretsFile = { toString: { currentVersion: "1", versions: { "1": "v" } } };

    const result = await seedDevSecrets({ file, registry, store });

    expect(result.undeclared).toEqual(["toString"]);
  });
});

describe("mintMissingDevSecrets", () => {
  test("mints only what the registry says may be minted and the file does not have", () => {
    const file: DevSecretsFile = { "auth-session-secret": { currentVersion: "1", versions: { "1": "kept" } } };

    // `auth-google-credentials` has no `devValue` (Google issued it), `CONNECTION_SIGNING_KEY` is a
    // keyspace with no single value, and the session secret is already there.
    expect(mintMissingDevSecrets(file, registry)).toEqual({});
    expect(Object.keys(mintMissingDevSecrets({}, registry))).toEqual(["auth-session-secret"]);
  });

  test("what it mints is what the seeder would have — one minting rule, not two", async () => {
    // The CLI persists these to `.dev.secrets.jsonc` *before* seeding, so a failed file write cannot
    // leave a row in the store that no file explains. That only holds while both use this function.
    const store = new FakeStore();
    const minted = mintMissingDevSecrets({}, registry);

    const result = await seedDevSecrets({ file: minted, registry, store });

    expect(result.minted).toEqual({});
    expect(result.seeded).toEqual(["auth-session-secret"]);
    expect(store.rows.get("auth-session-secret")?.value).toEqual(minted["auth-session-secret"]);
  });

  test("an empty file inherits nothing from Object.prototype — `in` would call every name present", () => {
    const odd = defineSecretRegistry({
      toString: { backend: "d1", scope: "environment", rotatable: true, valueType: "text", devValue: "random" },
    });

    expect(Object.keys(mintMissingDevSecrets({}, odd))).toEqual(["toString"]);
  });
});

/**
 * The asymmetry the `bootstrap` axis exists for, asserted from both sides — because one side alone is
 * how it gets "tidied" back into a single rule that breaks the other.
 */
describe("devVarsForRegistry", () => {
  const registry = defineSecretRegistry({
    "connection-key": { backend: "cf-secrets-store", scope: "environment", rotatable: false, valueType: "text" },
    SECRETS_ENCRYPTION_KEYS: {
      backend: "cf-secrets-store",
      scope: "environment",
      rotatable: false,
      valueType: "text",
      bootstrap: true,
    },
    "auth-session-secret": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
  });

  const file: DevSecretsFile = {
    "connection-key": { currentVersion: "2", versions: { "1": "old", "2": "current" } },
    SECRETS_ENCRYPTION_KEYS: { currentVersion: "1", versions: { "1": "the-master-key" } },
    "auth-session-secret": { currentVersion: "1", versions: { "1": "seeded-into-d1" } },
  };

  test("an ordinary cf-secrets-store secret carries the whole envelope, so its versions survive", () => {
    // The same shape provisioning writes into the Secrets Store. Collapsing it to the current value
    // would drop version 1 and break anything still verifying against it.
    expect(devVarsForRegistry(file, registry)["connection-key"]).toBe(
      encodeVersionedValue({ currentVersion: "2", versions: { "1": "old", "2": "current" } }),
    );
  });

  test("a bootstrap secret carries its current value, because its reader has no decoder yet", () => {
    // `resolveEncryptionConfig` parses this binding directly — it is what the envelope decoder needs in
    // order to exist — so an envelope here is a Worker that boots into `not a valid EncryptionConfig`.
    expect(devVarsForRegistry(file, registry).SECRETS_ENCRYPTION_KEYS).toBe("the-master-key");
  });

  test("a d1 secret is not a binding at all — its destination is the row the seeder writes", () => {
    expect(devVarsForRegistry(file, registry)["auth-session-secret"]).toBeUndefined();
  });

  test("a declared secret the file does not state is simply absent, not an error", () => {
    expect(Object.keys(devVarsForRegistry({}, registry))).toEqual([]);
  });

  test("the seeder and the generator agree, because they are one function", () => {
    // Two implementations of "what does this binding carry" is how dev and the report drift apart.
    const store = new FakeStore();
    return seedDevSecrets({ file, registry, store }).then((result) => {
      expect(result.devVars).toEqual(devVarsForRegistry(file, registry));
    });
  });
});
