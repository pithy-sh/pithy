// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { resolveWriteTargets } from "@pithy-sh/secrets/src/scope";
import { describe, expect, test } from "vitest";
import { MEDIA_R2_SECRET, MEDIA_STORAGE_SECRET, mediaSecretsRegistry } from "./registry";

describe("mediaSecretsRegistry", () => {
  test("declares both names — its own credentials and the R2 bundle it points objectStore at", () => {
    expect(Object.keys(mediaSecretsRegistry).sort()).toEqual([MEDIA_R2_SECRET, MEDIA_STORAGE_SECRET]);
  });

  test("both live where provisioning actually puts them: encrypted rows in the secrets D1", () => {
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
      expect(resolveWriteTargets(entry.backend, entry.scope, "staging")).toEqual(["staging"]);
      expect(resolveWriteTargets(entry.backend, entry.scope, "prod")).toEqual(["prod"]);
    }
  });
});
