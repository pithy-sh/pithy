// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { auditSecrets, passesPromoteGate } from "./audit";

describe("auditSecrets", () => {
  test("flags declared secrets with no value as missing", () => {
    const audit = auditSecrets(["auth-signing-key", "npm-token"], ["npm-token"]);
    expect(audit.missing).toEqual(["auth-signing-key"]);
    expect(audit.orphan).toEqual([]);
  });

  test("flags stored secrets no longer in the registry as orphans", () => {
    const audit = auditSecrets(["a"], ["a", "old-secret"]);
    expect(audit.missing).toEqual([]);
    expect(audit.orphan).toEqual(["old-secret"]);
  });

  test("a fully-provisioned env has no missing and no orphans", () => {
    expect(auditSecrets(["a", "b"], ["b", "a"])).toEqual({ missing: [], orphan: [] });
  });
});

describe("passesPromoteGate", () => {
  test("fails when a declared secret is missing", () => {
    expect(passesPromoteGate(auditSecrets(["a", "b"], ["a"]))).toBe(false);
  });

  test("passes when nothing is missing (orphans are allowed)", () => {
    expect(passesPromoteGate(auditSecrets(["a"], ["a", "orphan"]))).toBe(true);
  });
});
