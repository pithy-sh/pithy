// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCloudflareEnv } from "@pithy-sh/cloudflare/src/env/devVars";
import { CloudflareSecretsStoreManager } from "@pithy-sh/cloudflare/src/secrets/secretsStoreManager";
import { uniqueName } from "@pithy-sh/cloudflare/src/test-utils/harness";
import { describe, expect, test } from "vitest";
import { SecretsStoreConfigWriter } from "./secretsConfigWriter";

/**
 * LIVE integration test — exercises the one path that cannot run locally: writing the master-key
 * config back to a real CF Secrets Store (the at-rest rotation's write-back). Reads creds from the
 * worktree `.dev.vars`; skipped when they are absent. Run via `bun run test:integration`. Required
 * before a release.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const vars = loadCloudflareEnv(path.join(__dirname, "../.."));
const hasCreds = Boolean(vars.CLOUDFLARE_API_TOKEN && vars.CLOUDFLARE_ACCOUNT_ID && vars.SECRETS_STORE_ID);

/**
 * A throwaway entry name so the test never touches the real `SECRETS_ENCRYPTION_KEYS`.
 *
 * Minted through `uniqueName`, so it sits in the reserved `pithy-int-` namespace rather than the
 * product's own `PITHY_SECRETS_*` one — a store entry a reaper is allowed to reclaim, instead of one that
 * looks like a real project's master key. Computed once: write, overwrite and delete all address it.
 */
const TEST_SECRET = uniqueName("secretsconfig");

describe.skipIf(!hasCreds)("SecretsStoreConfigWriter — LIVE CF Secrets Store", () => {
  test("writes a config entry, overwrites it, then removes it", async () => {
    const manager = new CloudflareSecretsStoreManager({
      accountId: vars.CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: vars.CLOUDFLARE_API_TOKEN ?? "",
      storeId: vars.SECRETS_STORE_ID ?? "",
    });
    const writer = new SecretsStoreConfigWriter(manager, TEST_SECRET);
    try {
      await writer.write(
        JSON.stringify({ currentVersion: "1", versions: { "1": "x" }, lastRotatedAt: "2026-01-01T00:00:00.000Z" }),
      );
      expect(await manager.exists(TEST_SECRET)).toBe(true);
      // Overwrite in place — the entry is edited, never deleted first, so it stays bound throughout.
      await writer.write(
        JSON.stringify({ currentVersion: "2", versions: { "2": "y" }, lastRotatedAt: "2026-02-01T00:00:00.000Z" }),
      );
      expect(await manager.exists(TEST_SECRET)).toBe(true);
    } finally {
      await manager.deleteSecret(TEST_SECRET).catch(() => {});
    }
  });
});
