// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { inputOf } from "@pithy-sh/core/src/controlPlane/discovery/routeInput";
import { validate } from "@pithy-sh/core/src/http/validation";
import { describe, expect, test } from "vitest";
import { AdminReposQuery } from "./schemas";

describe("AdminReposQuery", () => {
  test("decodes remote access to a boolean and takes the owner as kind and id", () => {
    expect(AdminReposQuery.parse({ remoteAccess: "false", ownerKind: "org", ownerId: "acme" })).toEqual({
      remoteAccess: false,
      ownerKind: "org",
      ownerId: "acme",
    });
    expect(AdminReposQuery.parse({ ownerKind: "user" })).toEqual({ ownerKind: "user" });
  });

  test("refuses an owner id without its kind, an unknown kind, and a remote access that is not a boolean", () => {
    expect(AdminReposQuery.safeParse({ ownerId: "acme" }).success).toBe(false);
    expect(AdminReposQuery.safeParse({ ownerKind: "team" }).success).toBe(false);
    expect(AdminReposQuery.safeParse({ remoteAccess: "1" }).success).toBe(false);
  });

  test("every filter reaches the manifest's route input, so a client can discover it", () => {
    const input = inputOf([validate("query", AdminReposQuery)]).properties as { query: { properties: object } };
    expect(Object.keys(input.query.properties)).toEqual(
      expect.arrayContaining(["remoteAccess", "ownerKind", "ownerId"]),
    );
  });
});
