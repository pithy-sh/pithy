// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SettingsAccountReader } from "@pithy-sh/core/src/capability/settings";
import { describe, expect, test } from "vitest";
import { supersededManagerToken } from "./supersededToken";

const environments = ["dev", "staging", "prod"].map((name) => ({ name, origin: null }));
const context = { project: "acme", worker: "acme-api", workerDirectory: "api", environments };

/** An account where `minted` environments hold a runtime token, and `tokens` names every API token it holds. */
function account(minted: string[], tokens: string[]): SettingsAccountReader {
  return {
    d1Databases: async () => [],
    zone: async () => false,
    vaultSecret: async () => false,
    vaultSecretField: async () => false,
    appRows: async () => [],
    storeEntry: async (name) => minted.some((env) => name === `acme-${env}-runtime-cf-api-token`),
    accountToken: async (name) => tokens.includes(name),
  };
}

describe("supersededManagerToken — the secrets manager's own token, superseded by runtime (#728)", () => {
  const check = supersededManagerToken();

  test("names the global manager token while it is still in the account, once runtime is minted", async () => {
    const findings = await check.account?.({
      ...context,
      account: account(["staging"], ["acme-global-secrets-manager"]),
    });
    expect(findings).toEqual([
      {
        setting: "acme-global-secrets-manager",
        environment: null,
        problem:
          "The secrets manager's own Cloudflare token is still in the account. The runtime token replaced it, and nothing reads it once every manager is redeployed.",
        action: expect.stringContaining("Manage Account → Account API Tokens. Nothing revokes it for you."),
      },
    ]);
    // The redeploy runs against production, so it is said as a person's decision and carries no fix.
    expect(findings?.[0]?.action).toContain("`pithy secrets provision`");
    expect(findings?.[0]).not.toHaveProperty("fix");
  });

  test("names a manager token minted per environment, with the revoke that removes it", async () => {
    const findings = await check.account?.({ ...context, account: account(["prod"], ["acme-prod-secrets"]) });
    expect(findings).toEqual([expect.objectContaining({ setting: "acme-prod-secrets", environment: "prod" })]);
    // A revoke deletes a credential: named, never carried as a fix a script would run.
    expect(findings?.[0]?.action).toContain("`pithy token revoke secrets --env prod`");
    expect(findings?.[0]).not.toHaveProperty("fix");
  });

  test("says nothing until runtime is minted somewhere — until then the old token is the one that works", async () => {
    expect(
      await check.account?.({ ...context, account: account([], ["acme-global-secrets-manager", "acme-prod-secrets"]) }),
    ).toEqual([]);
  });

  test("says nothing once the old tokens are gone", async () => {
    expect(await check.account?.({ ...context, account: account(["staging", "prod"], []) })).toEqual([]);
  });
});
