// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CloudflareSecretsStoreManager } from "@pithy-sh/cloudflare/src/secrets/secretsStoreManager";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test, vi } from "vitest";
import { masterKeySecretName } from "../provision/provisionSecrets";
import { rotationConfigWriter } from "./secretsConfigWriter";

/** A fake Secrets Store manager exposing only `putSecret`, with a spy. */
function fakeManager() {
  const putSecret = vi.fn(async (_name: string, _value: string) => {});
  return { manager: { putSecret } as unknown as CloudflareSecretsStoreManager, putSecret };
}

describe("rotationConfigWriter", () => {
  // Regression guard for the rotation write-back: it must target the project- and env-scoped master-key
  // entry the worker binds. Targeting the wrong entry is not a failure — it is a successful write to the
  // wrong place, persisting the rotated key set where the binding never reads it and leaving every
  // re-encrypted row undecryptable.
  test("writes back to <project>-<env>-secrets-encryption-keys, the entry the binding reads", async () => {
    const { manager, putSecret } = fakeManager();
    await rotationConfigWriter(manager, "acme", "staging").write("new-config");
    expect(putSecret).toHaveBeenCalledWith(masterKeySecretName("acme", "staging"), "new-config");
    expect(putSecret).toHaveBeenCalledWith("acme-staging-secrets-encryption-keys", "new-config");
  });

  test("prod targets its own entry, not staging's", async () => {
    const { manager, putSecret } = fakeManager();
    await rotationConfigWriter(manager, "acme", "prod").write("c");
    expect(putSecret).toHaveBeenCalledWith("acme-prod-secrets-encryption-keys", "c");
  });

  test("one project's rotation can never land on another project's key entry", async () => {
    const acme = fakeManager();
    const globex = fakeManager();
    await rotationConfigWriter(acme.manager, "acme", "prod").write("a");
    await rotationConfigWriter(globex.manager, "globex", "prod").write("g");
    expect(acme.putSecret.mock.calls[0]?.[0]).not.toBe(globex.putSecret.mock.calls[0]?.[0]);
  });

  test("rejects an unknown environment — the wrangler ENVIRONMENT var is validated", () => {
    const { manager } = fakeManager();
    expect(() => rotationConfigWriter(manager, "acme", "staging-typo")).toThrow(PithyError);
  });

  test("rejects a missing project — an unstamped PROJECT var must fail, not write an unscoped entry", () => {
    const { manager } = fakeManager();
    expect(() => rotationConfigWriter(manager, "", "staging")).toThrow(PithyError);
  });
});
