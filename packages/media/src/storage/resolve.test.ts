// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { RUNTIME_TOKEN_SECRET } from "@pithy-sh/cloudflare/src/tokens/runtime";
import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { SecretsAccessor } from "@pithy-sh/secrets/src/secretsStore";
import { configureSharedSecrets, resetSharedSecrets } from "@pithy-sh/secrets/src/sharedSecretsStore";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MediaConfig } from "../config/config";
import { MEDIA_R2_SECRET, MEDIA_STORAGE_SECRET, mediaSecretsRegistryFor } from "../secret/registry";
import { assetOwner, mediaCloudflareConfig, resolveStorage, type StorageEnv } from "./resolve";

/**
 * The runtime half of the ownership stamp: which project and environment the Worker says it is.
 * Cloudflare Images and Stream have no local emulation — a `pithy dev` upload writes to the same
 * account-flat store prod does — so the answer has to be right in every environment, and a
 * guess is worse than a failure.
 */

const env = (vars: Partial<StorageEnv>) => vars as StorageEnv;

describe("assetOwner", () => {
  test("reads the project and environment the Worker was stamped with at provision", () => {
    expect(assetOwner(env({ PROJECT: "acme", ENVIRONMENT: "prod" }))).toEqual({
      project: "acme",
      env: "prod",
    });
  });

  test("an absent ENVIRONMENT is local dev — the same signal the secrets reader keys on", () => {
    expect(assetOwner(env({ PROJECT: "acme" }))).toEqual({ project: "acme", env: "dev" });
  });

  test("refuses to mint without PROJECT rather than writing an asset nothing can attribute", () => {
    expect(() => assetOwner(env({ ENVIRONMENT: "staging" }))).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "core/internal" }) }),
    );
  });

  test("the failure names the fix — the var, not the symptom", () => {
    expect(() => assetOwner(env({}))).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ action: expect.stringContaining("PROJECT") }) }),
    );
  });

  test("a blank PROJECT is refused too — it would stamp every asset as owned by nobody", () => {
    expect(() => assetOwner(env({ PROJECT: "   " }))).toThrowError(
      expect.objectContaining({ payload: expect.objectContaining({ code: "core/internal" }) }),
    );
  });
});

const R2_ONLY = MediaConfig.parse({ images: { store: "r2" }, video: { store: "r2" } });
const ON_CLOUDFLARE = MediaConfig.parse({});

const R2_BUNDLE = {
  accessKeyId: "AKIA-test",
  secretAccessKey: "secret-test",
  accountId: "acct-1",
  bucket: "acme-prod-media",
  apiToken: "r2-scoped",
};

/**
 * Configure the shared reader the way a composed Worker does: over the registry this config's `media()`
 * declares, and nothing else — so a read of a name it does not declare fails exactly as it does deployed.
 */
function composedFor(config: MediaConfig, values: Record<string, unknown>) {
  const registry = mediaSecretsRegistryFor(config) as SecretRegistry;
  const resolve = vi.fn(
    async () =>
      new SecretsAccessor(
        registry,
        Object.fromEntries(
          Object.entries(values).map(([name, current]) => [
            name,
            { current, currentVersion: "1", versions: { 1: current } },
          ]),
        ),
      ),
  );
  configureSharedSecrets({ registry, resolve });
  return resolve;
}

afterEach(() => resetSharedSecrets());

describe("resolveStorage — an R2-only project (#728)", () => {
  test("resolves without reading a token, a project, or a Cloudflare account", async () => {
    const resolve = composedFor(R2_ONLY, {});
    await resolveStorage(env({}), R2_ONLY);
    expect(resolve).not.toHaveBeenCalled();
  });

  test("mints every type's upload in R2, reading only the R2 bundle", async () => {
    composedFor(R2_ONLY, { [MEDIA_R2_SECRET]: R2_BUNDLE });
    const storage = await resolveStorage(env({}), R2_ONLY);
    for (const type of ["image", "video", "audio", "document"] as const) {
      const target = await storage.mintUpload({ type, id: `id-${type}`, contentType: "application/octet-stream" });
      expect(target.storageBackend).toBe("r2");
      expect(target.uploadUrl).toContain("X-Amz-Signature=");
    }
  });

  test("asked for Cloudflare anyway — a record stored before the config moved — refuses by name", async () => {
    composedFor(R2_ONLY, {});
    await expect(mediaCloudflareConfig(env({}), R2_ONLY)()).rejects.toMatchObject({
      payload: { code: "core/internal", action: expect.stringContaining("token rotate runtime") },
    });
  });
});

describe("mediaCloudflareConfig — the runtime token (#728)", () => {
  test("reaches Images and Stream with the application's runtime token, in media's own account", async () => {
    composedFor(ON_CLOUDFLARE, {
      [RUNTIME_TOKEN_SECRET]: "runtime-token",
      [MEDIA_STORAGE_SECRET]: { accountId: "acct-1" },
    });
    expect(await mediaCloudflareConfig(env({}), ON_CLOUDFLARE)()).toEqual({
      apiToken: "runtime-token",
      accountId: "acct-1",
    });
  });

  test("a bundle still carrying a supplied token is never read for one", async () => {
    composedFor(ON_CLOUDFLARE, {
      [RUNTIME_TOKEN_SECRET]: "runtime-token",
      [MEDIA_STORAGE_SECRET]: { accountId: "acct-1", apiToken: "hand-made" },
    });
    expect((await mediaCloudflareConfig(env({}), ON_CLOUDFLARE)()).apiToken).toBe("runtime-token");
  });

  test("reads once, however many calls ask", async () => {
    const resolve = composedFor(ON_CLOUDFLARE, {
      [RUNTIME_TOKEN_SECRET]: "runtime-token",
      [MEDIA_STORAGE_SECRET]: { accountId: "acct-1" },
    });
    const config = mediaCloudflareConfig(env({}), ON_CLOUDFLARE);
    await Promise.all([config(), config(), config()]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
