// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { betterAuthSecrets, priorSessionSecrets } from "./sessionSecrets";

describe("betterAuthSecrets — every retained version, newest first (#602)", () => {
  test("hands Better Auth the current version first and every prior one after it, as integers", () => {
    expect(betterAuthSecrets({ currentVersion: "3", versions: { "1": "one", "2": "two", "3": "three" } })).toEqual({
      secrets: [
        { version: 3, value: "three" },
        { version: 2, value: "two" },
        { version: 1, value: "one" },
      ],
      // The oldest retained version opens a key sealed before the kit passed a version set at all.
      secret: "one",
    });
  });

  test("orders versions as numbers, so version 10 is newer than version 9", () => {
    const { secrets } = betterAuthSecrets({ currentVersion: "10", versions: { "9": "nine", "10": "ten" } });
    expect(secrets.map((one) => one.version)).toEqual([10, 9]);
  });

  test("a secret that has never rotated is a version set of one, and its own legacy value", () => {
    expect(betterAuthSecrets({ currentVersion: "1", versions: { "1": "only" } })).toEqual({
      secrets: [{ version: 1, value: "only" }],
      secret: "only",
    });
  });

  test("current first even when it is not the highest key, because the pointer is what decides", () => {
    const { secrets } = betterAuthSecrets({ currentVersion: "2", versions: { "1": "one", "2": "two", "3": "three" } });
    expect(secrets[0]).toEqual({ version: 2, value: "two" });
  });
});

describe("priorSessionSecrets", () => {
  test("is every retained value but the current one, newest first", () => {
    expect(priorSessionSecrets({ currentVersion: "3", versions: { "1": "one", "2": "two", "3": "three" } })).toEqual([
      "two",
      "one",
    ]);
    expect(priorSessionSecrets({ currentVersion: "1", versions: { "1": "only" } })).toEqual([]);
  });
});
