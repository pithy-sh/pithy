// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import type { AppRowsRequest, SettingsAccountContext } from "../capability/settings";
import { recordsOutsidePolicy } from "./policyCheck";
import { VisibilityPolicy } from "./visibility";

function context(appRows: (request: AppRowsRequest) => Promise<readonly string[]>): SettingsAccountContext {
  return {
    project: "acme",
    worker: "acme-api",
    workerDirectory: "api",
    environments: [
      { name: "dev", origin: null },
      { name: "staging", origin: null },
      { name: "prod", origin: null },
    ],
    account: {
      d1Databases: async () => [],
      zone: async () => true,
      vaultSecret: async () => true,
      storeEntry: async () => true,
      appRows,
    },
  };
}

const narrowed = VisibilityPolicy.parse({ allowed: ["private", "organization"] });

describe("recordsOutsidePolicy", () => {
  test("after allowed narrows, names every record outside it, per deployed environment", async () => {
    const appRows = vi.fn(async (request: AppRowsRequest) => (request.environment === "prod" ? ["m1", "m2"] : []));
    const check = recordsOutsidePolicy({
      capability: "media",
      noun: "media record",
      table: "pithy_media_assets",
      policy: narrowed,
      remedy: "Change each with PATCH /media/:id",
    });
    const findings = await check.account?.(context(appRows));
    expect(findings).toEqual([
      {
        setting: "media visibility.allowed",
        environment: "prod",
        problem:
          "2 media records are public, which visibility.allowed (private, organization) no longer allows: m1, m2.",
        action:
          "Nothing is rewritten for you. Change each with PATCH /media/:id, or widen visibility.allowed in api's pithy.config.ts.",
      },
    ]);
    // Asked of every deployed environment, never of dev, for exactly the levels the policy dropped.
    expect(appRows.mock.calls.map(([request]) => request.environment)).toEqual(["staging", "prod"]);
    expect(appRows.mock.calls[0]?.[0]).toMatchObject({
      table: "pithy_media_assets",
      column: "visibility",
      values: ["public"],
    });
  });

  test("asks nothing while every level is allowed", async () => {
    const appRows = vi.fn(async () => ["m1"]);
    const check = recordsOutsidePolicy({
      capability: "storage",
      noun: "file",
      table: "pithy_storage_objects",
      policy: VisibilityPolicy.parse({}),
      remedy: "Change each with PATCH /storage/:id",
    });
    expect(await check.account?.(context(appRows))).toEqual([]);
    expect(appRows).not.toHaveBeenCalled();
  });

  test("an environment the account cannot answer for is unchecked — the refusal propagates, never a pass", async () => {
    const check = recordsOutsidePolicy({
      capability: "media",
      noun: "media record",
      table: "pithy_media_assets",
      policy: narrowed,
      remedy: "Change each",
    });
    await expect(
      check.account?.(
        context(async () => {
          throw new Error("no app database");
        }),
      ),
    ).rejects.toThrow("no app database");
  });

  test("the local tier says nothing — which records exist is the deployed database's to say", () => {
    const check = recordsOutsidePolicy({
      capability: "media",
      noun: "media record",
      table: "pithy_media_assets",
      policy: narrowed,
      remedy: "x",
    });
    expect(check.local({ project: "acme", worker: "w", workerDirectory: "api", environments: [] })).toEqual([]);
  });
});
