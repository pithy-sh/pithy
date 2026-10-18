// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SettingsAccountIncomplete, type SettingsAccountReader } from "@pithy-sh/core/src/capability/settings";
import { describe, expect, test } from "vitest";
import { storage } from "../capability";
import { bundleTokenCheck, R2_BUNDLE_TOKEN_FIELD } from "./bundleToken";
import { STORAGE_R2_SECRET } from "./registry";

const environments = ["dev", "staging", "prod"].map((name) => ({ name, origin: null }));
const context = { project: "acme", worker: "acme-api", workerDirectory: "api", environments };

/** An account where `minted` environments hold a runtime token and `carrying` ones a bundle with a token. */
function account(minted: string[], carrying: string[], refuse: string[] = []): SettingsAccountReader {
  return {
    d1Databases: async () => [],
    zone: async () => false,
    vaultSecret: async () => true,
    appRows: async () => [],
    accountToken: async () => false,
    storeEntry: async (name) => minted.some((env) => name === `acme-${env}-runtime-cf-api-token`),
    vaultSecretField: async ({ name, environment, field }) => {
      if (refuse.includes(environment)) throw new Error(`${environment} has no manager`);
      expect([name, field]).toEqual([STORAGE_R2_SECRET, R2_BUNDLE_TOKEN_FIELD]);
      return carrying.includes(environment);
    },
  };
}

describe("bundleTokenCheck — a Cloudflare API token still stored beside the R2 key pair (#728)", () => {
  const check = bundleTokenCheck({ secret: STORAGE_R2_SECRET, provision: "storage provision" });

  test("names each upgraded environment whose bundle still carries one, with the provision that rewrites it", async () => {
    const findings = await check.account?.({ ...context, account: account(["staging", "prod"], ["prod"]) });
    expect(findings).toEqual([
      expect.objectContaining({
        setting: "storage-r2-credentials apiToken",
        environment: "prod",
        problem:
          "storage-r2-credentials still holds a Cloudflare API token beside the R2 key pair. Nothing reads it, and the application holds one token: runtime.",
      }),
    ]);
    expect(findings?.[0]?.action).toContain(
      "Then run pithy storage provision --worker api to rewrite the bundle without it.",
    );
    expect(findings?.[0]?.fix).toBe("pithy storage provision --worker api");
    // The key pair derives from the R2 token, so revoking it breaks the pair the rewritten bundle signs with.
    expect(findings?.[0]?.action).not.toMatch(/revoke that token if it was made for R2/i);
    expect(findings?.[0]?.action).toContain(
      "Keep that token. It is your bootstrap one, or the R2 token the key pair derives from, and revoking that breaks the pair.",
    );
    expect(findings?.[0]?.action).toMatch(/^Deploy your app Workers on this kit first\./);
  });

  test("says nothing where runtime is not minted yet, and never asks of dev", async () => {
    expect(await check.account?.({ ...context, account: account([], ["staging", "prod"]) })).toEqual([]);
    expect(await check.account?.({ ...context, account: account(["dev"], ["dev"]) })).toEqual([]);
  });

  test("an environment that cannot answer is unchecked, and the others still report", async () => {
    const run = check.account?.({ ...context, account: account(["staging", "prod"], ["staging"], ["prod"]) });
    const error = await run?.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SettingsAccountIncomplete);
    expect((error as SettingsAccountIncomplete).unanswered).toEqual(["prod"]);
    expect((error as SettingsAccountIncomplete).findings.map((finding) => finding.environment)).toEqual(["staging"]);
  });

  test("storage composes it, so doctor asks of its own bundle", async () => {
    const findings = await storage().settings?.account?.({ ...context, account: account(["prod"], ["prod"]) });
    expect(findings?.map((finding) => finding.setting)).toContain("storage-r2-credentials apiToken");
  });
});
