// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: FSL-1.1-MIT

import { SettingsAccountIncomplete, type SettingsAccountReader } from "@pithy-sh/core/src/capability/settings";
import { describe, expect, test } from "vitest";
import { checkpointLockCheck } from "./lockCheck";

/** A reader that answers the lock question from a table, and refuses everything else. */
function reader(states: Record<string, "locked" | "unlocked" | "missing">): SettingsAccountReader {
  const refuse = async () => {
    throw new Error("not asked here");
  };
  return {
    d1Databases: refuse,
    zone: refuse,
    vaultSecret: refuse,
    storeEntry: refuse,
    appRows: refuse,
    vaultSecretField: refuse,
    accountToken: refuse,
    r2BucketLock: async ({ bucket, prefix }) => {
      expect(prefix).toBe("checkpoints/");
      const state = states[bucket];
      if (!state) throw new Error(`unexpected bucket ${bucket}`);
      return state;
    },
  };
}

const context = (account: SettingsAccountReader) => ({
  project: "acme",
  worker: "api",
  workerDirectory: "api",
  environments: [
    { name: "dev", origin: null },
    { name: "staging", origin: null },
    { name: "prod", origin: null },
  ],
  account,
});

describe("checkpointLockCheck (#822)", () => {
  test("says nothing where the lock is in force, and never asks dev", async () => {
    const check = checkpointLockCheck();
    expect(
      await check.account?.(
        context(reader({ "acme-staging-audit-checkpoints": "locked", "acme-prod-audit-checkpoints": "locked" })),
      ),
    ).toEqual([]);
  });

  test("names an unlocked bucket, with the command that locks it", async () => {
    const findings = await checkpointLockCheck().account?.(
      context(reader({ "acme-staging-audit-checkpoints": "unlocked", "acme-prod-audit-checkpoints": "locked" })),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        setting: "AUDIT_CHECKPOINTS object lock",
        environment: "staging",
        fix: "pithy audit lock --env staging",
      }),
    ]);
    expect(findings?.[0]?.problem).toMatch(/not in force on acme-staging-audit-checkpoints/);
  });

  test("names a bucket that does not exist, and an unlocked one beside it", async () => {
    const findings = await checkpointLockCheck().account?.(
      context(reader({ "acme-staging-audit-checkpoints": "missing", "acme-prod-audit-checkpoints": "unlocked" })),
    );
    expect(findings?.map((finding) => [finding.environment, finding.setting])).toEqual([
      ["staging", "AUDIT_CHECKPOINTS bucket"],
      ["prod", "AUDIT_CHECKPOINTS object lock"],
    ]);
    expect(findings?.[0]?.action).toMatch(/pithy provision --env staging --yes/);
    expect(findings?.[1]?.fix).toBe("pithy audit lock --env prod");
  });

  test("a reader that cannot ask leaves every deployed environment unanswered", async () => {
    const { r2BucketLock: _, ...older } = reader({});
    await expect(checkpointLockCheck().account?.(context(older))).rejects.toBeInstanceOf(SettingsAccountIncomplete);
  });
});
