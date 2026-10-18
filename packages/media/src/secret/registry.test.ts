// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { RUNTIME_TOKEN_SECRET } from "@pithy-sh/cloudflare/src/tokens/runtime";
import { DEFAULT_ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import type { SecretRegistryEntry } from "@pithy-sh/secrets/src/registry";
import { resolveWriteTargets } from "@pithy-sh/secrets/src/scope";
import { describe, expect, test } from "vitest";
import { media } from "../capability";
import { MediaConfig } from "../config/config";
import {
  MEDIA_BUCKET_BINDING,
  MEDIA_IMAGES_SIGNING_SECRET,
  MEDIA_R2_SECRET,
  MEDIA_STORAGE_SECRET,
  MEDIA_STREAM_SIGNING_SECRET,
  MediaStorageCredentials,
  mediaOwnSecretsRegistry,
  mediaRuntimePermissions,
  mediaSecretsRegistry,
  mediaSecretsRegistryFor,
} from "./registry";

describe("mediaSecretsRegistry", () => {
  test("declares its account, its two signing keys, the R2 bundle it points objectStore at, and the runtime token", () => {
    expect(Object.keys(mediaOwnSecretsRegistry).sort()).toEqual(
      [MEDIA_IMAGES_SIGNING_SECRET, MEDIA_R2_SECRET, MEDIA_STORAGE_SECRET, MEDIA_STREAM_SIGNING_SECRET].sort(),
    );
    expect(Object.keys(mediaSecretsRegistry).sort()).toEqual(
      [...Object.keys(mediaOwnSecretsRegistry), RUNTIME_TOKEN_SECRET].sort(),
    );
  });

  test("the signing keys are json bundles of single-line fields, read where provisioning writes them", () => {
    for (const entry of [
      mediaSecretsRegistry[MEDIA_IMAGES_SIGNING_SECRET],
      mediaSecretsRegistry[MEDIA_STREAM_SIGNING_SECRET],
    ] as SecretRegistryEntry[]) {
      expect(entry.backend).toBe("d1");
      expect(entry.valueType).toBe("json");
      expect(entry.binding).toBeUndefined();
    }
  });

  test("the runtime token is the application's one, read through its Secrets Store binding (#728)", () => {
    // `pithy token mint runtime` writes it to the store, so a `d1` declaration would send the read to a
    // row nothing writes.
    expect(mediaSecretsRegistry[RUNTIME_TOKEN_SECRET]).toMatchObject({
      backend: "cf-secrets-store",
      scope: "environment",
      valueType: "text",
    });
  });

  test("its own two live where provisioning actually puts them: encrypted rows in the secrets D1", () => {
    // No wrangler template binds either from the Cloudflare Secrets Store — `pithy media provision`
    // writes both through `dispatchSecretWrite` → the manager Workflow → `SystemSecretsStore`. The read
    // seam routes strictly on `backend`, so the wrong declaration sends a deployed read to a binding
    // that does not exist.
    expect(mediaSecretsRegistry[MEDIA_STORAGE_SECRET]?.backend).toBe("d1");
    expect(mediaSecretsRegistry[MEDIA_R2_SECRET]?.backend).toBe("d1");
  });

  test("a write still targets exactly the requested environment", () => {
    // The backend correction is a declaration fix, not a routing change: `environment` scope means one
    // target either way. Only a scope change would fan a write out across environments.
    // Iterate the values rather than index by name: the registry is a `const` object with no index
    // signature, so a `string` key would not narrow — and every entry is covered either way.
    for (const entry of Object.values(mediaSecretsRegistry)) {
      expect(resolveWriteTargets(entry.backend, entry.scope, "staging", DEFAULT_ENVIRONMENTS)).toEqual(["staging"]);
      expect(resolveWriteTargets(entry.backend, entry.scope, "prod", DEFAULT_ENVIRONMENTS)).toEqual(["prod"]);
    }
  });
});

/**
 * **The R2 bundle names the bucket it presigns (#541).**
 *
 * The relation was a sentence in `r2CredentialsRegistry`'s docstring, so a project that declined the
 * bucket was still asked for the credential whose only purpose is reaching it. One constant feeds the
 * entry and the capability's binding, and this is what fails if they are ever split.
 */
describe("media-r2-credentials — the bucket it exists to reach", () => {
  test("declares the binding", () => {
    expect(mediaSecretsRegistry[MEDIA_R2_SECRET]?.binding).toBe(MEDIA_BUCKET_BINDING);
  });

  test("and it is the r2 binding the capability declares", () => {
    const r2 = media({}).requiredBindings.filter((binding) => binding.type === "r2");
    expect(r2.map((binding) => binding.name)).toContain(mediaSecretsRegistry[MEDIA_R2_SECRET]?.binding);
  });

  /** Media's own credentials reach no binding — they mint Images and Stream upload URLs over HTTPS. */
  test("media's own credentials declare none, because they address no binding", () => {
    const own: SecretRegistryEntry = mediaSecretsRegistry[MEDIA_STORAGE_SECRET];
    expect(own.binding).toBeUndefined();
  });
});

describe("media-storage-credentials carries no token (#728)", () => {
  test("holds the account id and nothing else", () => {
    expect(Object.keys(MediaStorageCredentials.shape)).toEqual(["accountId"]);
  });

  test("a bundle written before #728 still reads, and the supplied token is dropped rather than used", () => {
    expect(MediaStorageCredentials.parse({ apiToken: "hand-made", accountId: "acct-1" })).toEqual({
      accountId: "acct-1",
    });
  });
});

describe("mediaRuntimePermissions (#728)", () => {
  const config = (input: Parameters<typeof MediaConfig.parse>[0]) => MediaConfig.parse(input);

  test("images in Cloudflare Images and video in Stream need uploads on both, and the delivery read", () => {
    expect(mediaRuntimePermissions(config({}))).toEqual(["images:write", "stream:write", "analytics:read"]);
  });

  test("one type on a Cloudflare product needs that product and the delivery read", () => {
    expect(mediaRuntimePermissions(config({ video: { store: "r2" } }))).toEqual(["images:write", "analytics:read"]);
    expect(mediaRuntimePermissions(config({ images: { store: "r2" } }))).toEqual(["stream:write", "analytics:read"]);
  });

  test("a project storing both in R2 calls Cloudflare for nothing", () => {
    expect(mediaRuntimePermissions(config({ images: { store: "r2" }, video: { store: "r2" } }))).toEqual([]);
  });
});

describe("mediaSecretsRegistryFor (#728)", () => {
  test("declares the runtime token, with what this config needs of it, when a type is on a Cloudflare product", () => {
    const registry = mediaSecretsRegistryFor(MediaConfig.parse({ video: { store: "r2" } }));
    const entry = (registry as unknown as Record<string, SecretRegistryEntry | undefined>)[RUNTIME_TOKEN_SECRET];
    expect(entry?.origin?.kind === "helped" && entry.origin.needs.cloudflare).toEqual([
      "images:write",
      "analytics:read",
    ]);
  });

  test("an R2-only project declares no token at all — provision would bind one, and nothing reads it", () => {
    const registry = mediaSecretsRegistryFor(MediaConfig.parse({ images: { store: "r2" }, video: { store: "r2" } }));
    expect(Object.keys(registry)).not.toContain(RUNTIME_TOKEN_SECRET);
    expect(registry).toBe(mediaOwnSecretsRegistry);
  });
});
