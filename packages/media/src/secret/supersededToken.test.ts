// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SettingsAccountIncomplete, type SettingsAccountReader } from "@pithy-sh/core/src/capability/settings";
import { describe, expect, test } from "vitest";
import { MEDIA_STORAGE_SECRET, MEDIA_SUPPLIED_TOKEN_FIELD } from "./registry";
import { suppliedTokenCheck } from "./supersededToken";

const environments = ["dev", "staging", "prod"].map((name) => ({ name, origin: null }));
const context = { project: "acme", worker: "acme-api", workerDirectory: "api", environments };

/** An account where `minted` environments hold a runtime token and `carrying` ones a bundle with the old token. */
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
      expect([name, field]).toEqual([MEDIA_STORAGE_SECRET, MEDIA_SUPPLIED_TOKEN_FIELD]);
      return carrying.includes(environment);
    },
  };
}

describe("suppliedTokenCheck — a media token the runtime token superseded (#728)", () => {
  const check = suppliedTokenCheck();

  test("names each environment whose bundle still carries it, once runtime is minted there", async () => {
    const findings = await check.account?.({ ...context, account: account(["staging", "prod"], ["prod"]) });
    expect(findings).toEqual([
      expect.objectContaining({
        setting: "media-storage-credentials apiToken",
        environment: "prod",
        problem:
          "media-storage-credentials still holds the Images and Stream token supplied to pithy media provision. The runtime token replaced it, and nothing reads it.",
      }),
    ]);
    expect(findings?.[0]?.action).toContain(
      "Then run pithy media provision --worker api to rewrite the bundle without it.",
    );
    expect(findings?.[0]?.fix).toBe("pithy media provision --worker api");
    // The token defaulted to the bootstrap one, so a bare "revoke it" would revoke the operator's own.
    expect(findings?.[0]?.action).not.toContain("Then revoke that token where it was made.");
    expect(findings?.[0]?.action).toContain(
      "Revoke that token only if you made it for media. Unless you passed --api-token, it is your bootstrap CLOUDFLARE_API_TOKEN: keep it.",
    );
    // Rewriting the bundle before the app Worker runs this kit breaks an old reader, so the order is named.
    expect(findings?.[0]?.action).toMatch(/^Deploy your app Workers on this kit first\./);
  });

  test("says nothing where runtime is not minted yet — the upgrade has not started there", async () => {
    expect(await check.account?.({ ...context, account: account([], ["staging", "prod"]) })).toEqual([]);
  });

  test("never asks of dev, which has no manager to open the bundle", async () => {
    expect(await check.account?.({ ...context, account: account(["dev"], ["dev"]) })).toEqual([]);
  });

  test("an environment that cannot answer is unchecked, and the others still report", async () => {
    const run = check.account?.({ ...context, account: account(["staging", "prod"], ["staging"], ["prod"]) });
    const error = await run?.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SettingsAccountIncomplete);
    expect((error as SettingsAccountIncomplete).unanswered).toEqual(["prod"]);
    expect((error as SettingsAccountIncomplete).findings.map((finding) => finding.environment)).toEqual(["staging"]);
  });

  test("the local tier says nothing: what a vault holds is the account's to answer", async () => {
    expect(await check.local(context)).toEqual([]);
  });
});
