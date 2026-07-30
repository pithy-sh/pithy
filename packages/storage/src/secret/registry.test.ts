// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { defineSecretRegistry, type SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { SecretsAccessor } from "@pithy-sh/secrets/src/secretsStore";
import {
  aggregateSecretRegistries,
  configureSharedSecrets,
  resetSharedSecrets,
  sharedSecretsStore,
} from "@pithy-sh/secrets/src/sharedSecretsStore";
import { afterEach, describe, expect, test } from "vitest";
import { R2StorageCredentials, r2CredentialsRegistry, STORAGE_R2_SECRET, storageSecretsRegistry } from "./registry";

/** A bare env — the fake resolver never touches it, so its shape is irrelevant here. */
const env = {} as Parameters<typeof sharedSecretsStore>[0];

const credentials: R2StorageCredentials = {
  accountId: "acct-1",
  accessKeyId: "ak-1",
  secretAccessKey: "sk-1",
  bucket: "pithy-storage",
  apiToken: "tok-1",
};

/** A resolved accessor over `registry`, every name carrying `credentials`, for the fake resolver to return. */
function fakeAccessor<R extends SecretRegistry>(registry: R): SecretsAccessor<R> {
  const resolved = Object.fromEntries(
    Object.keys(registry).map((name) => [
      name,
      { current: credentials, currentVersion: "1", versions: { "1": credentials } },
    ]),
  );
  return new SecretsAccessor(registry, resolved);
}

afterEach(() => resetSharedSecrets());

describe("r2CredentialsRegistry (the reason objectStore takes a factory, not a bare name)", () => {
  test("a name no capability declared cannot resolve — which is why a bare secretName string is not enough", async () => {
    configureSharedSecrets({ registry: {}, resolve: async () => fakeAccessor({}) });
    const undeclared = r2CredentialsRegistry("media-r2-credentials");
    await expect(sharedSecretsStore(env, undeclared)).rejects.toThrowError(/not in the aggregated registry/);
  });

  test("the same name resolves once the factory's slice is declared on a capability", async () => {
    const capability = defineCapability({
      name: "storage",
      requiredBindings: [],
      secretRegistry: storageSecretsRegistry,
    });
    const combined = aggregateSecretRegistries([capability]);
    configureSharedSecrets({ registry: combined, resolve: async () => fakeAccessor(combined) });

    const store = await sharedSecretsStore(env, storageSecretsRegistry);
    expect(store.get(STORAGE_R2_SECRET)).toEqual(credentials);
  });

  test("two capabilities may point the seam at different buckets under different names", async () => {
    const storage = defineCapability({ name: "storage", requiredBindings: [], secretRegistry: storageSecretsRegistry });
    const mediaRegistry = r2CredentialsRegistry("media-r2-credentials");
    const media = defineCapability({ name: "media", requiredBindings: [], secretRegistry: mediaRegistry });
    const combined = aggregateSecretRegistries([storage, media]);
    configureSharedSecrets({ registry: combined, resolve: async () => fakeAccessor(combined) });

    const mediaStore = await sharedSecretsStore(env, mediaRegistry);
    expect(mediaStore.get("media-r2-credentials")).toEqual(credentials);
    expect(Object.keys(combined).sort()).toEqual(["media-r2-credentials", "storage-r2-credentials"]);
  });

  test("one factory means two declarations of one name always agree on every axis", () => {
    const storage = defineCapability({ name: "storage", requiredBindings: [], secretRegistry: storageSecretsRegistry });
    const twin = defineCapability({
      name: "twin",
      requiredBindings: [],
      secretRegistry: r2CredentialsRegistry(STORAGE_R2_SECRET),
    });
    expect(() => aggregateSecretRegistries([storage, twin])).not.toThrow();

    // A hand-written declaration is exactly what the factory exists to prevent.
    const drifted = defineCapability({
      name: "rogue",
      requiredBindings: [],
      secretRegistry: defineSecretRegistry({
        [STORAGE_R2_SECRET]: { backend: "d1", scope: "global", rotatable: true, valueType: "text" },
      }),
    });
    expect(() => aggregateSecretRegistries([storage, drifted])).toThrowError(/declared incompatibly/);
  });
});

describe("R2StorageCredentials", () => {
  test("composes the cloudflare key pair rather than redeclaring it", () => {
    expect(Object.keys(R2StorageCredentials.shape).sort()).toEqual([
      "accessKeyId",
      "accountId",
      "apiToken",
      "bucket",
      "secretAccessKey",
    ]);
  });

  test("rejects an empty key — an unresolved credential fails here, not as an opaque SigV4 fault", () => {
    expect(R2StorageCredentials.safeParse({ ...credentials, accessKeyId: "" }).success).toBe(false);
  });
});
