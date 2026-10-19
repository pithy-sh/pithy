// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ActingOrganization } from "@pithy-sh/core/src/access/acting";
import { describe, expect, test } from "vitest";
import type { ArtifactsRepoRecord } from "../data/records";
import { accessTo, mayManage, tokenScope } from "./access";

const at = new Date(0);
const mine: ArtifactsRepoRecord = {
  name: "r1",
  displayName: "docs",
  ownerKind: "user",
  ownerId: "alice",
  remoteAccess: true,
  createdAt: at,
  updatedAt: at,
};
const theirs: ArtifactsRepoRecord = { ...mine, ownerKind: "org", ownerId: "acme" };

function acting(organizationId: string, powers: string[]): ActingOrganization {
  return { organizationId, roleAllows: (power) => powers.includes(power) };
}

describe("accessTo", () => {
  test("a person who owns the repository is its owner, whatever grant row exists", () => {
    expect(accessTo({ repo: mine, userId: "alice", grant: undefined, acting: null })).toBe("owner");
    expect(accessTo({ repo: mine, userId: "alice", grant: "read", acting: null })).toBe("owner");
  });

  test("a grant gives exactly what it says, and nothing gives nothing", () => {
    expect(accessTo({ repo: mine, userId: "bob", grant: "read", acting: null })).toBe("read");
    expect(accessTo({ repo: mine, userId: "bob", grant: "write", acting: null })).toBe("write");
    expect(accessTo({ repo: mine, userId: "bob", grant: undefined, acting: null })).toBeNull();
  });

  test("an organization's repository is owned by a member acting for it whose role holds managePower", () => {
    const args = { repo: theirs, userId: "bob", grant: undefined, managePower: "repos:manage" };
    expect(accessTo({ ...args, acting: acting("acme", ["repos:manage"]) })).toBe("owner");
    expect(accessTo({ ...args, acting: acting("acme", []) })).toBeNull();
    expect(accessTo({ ...args, acting: acting("other", ["repos:manage"]) })).toBeNull();
    expect(accessTo({ ...args, acting: null })).toBeNull();
  });

  test("without a managePower nobody owns an organization's repository through a role, only through a grant", () => {
    const args = { repo: theirs, userId: "bob", acting: acting("acme", ["repos:manage"]) };
    expect(accessTo({ ...args, grant: undefined })).toBeNull();
    expect(accessTo({ ...args, grant: "read" })).toBe("read");
  });

  test("a person's id equal to an organization's id owns nothing of the organization's", () => {
    expect(accessTo({ repo: theirs, userId: "acme", grant: undefined, acting: null })).toBeNull();
  });
});

describe("tokenScope", () => {
  test("an owner and a write grant mint write; a read grant mints read and never write", () => {
    expect(tokenScope("owner")).toBe("write");
    expect(tokenScope("write")).toBe("write");
    expect(tokenScope("read")).toBe("read");
  });
});

describe("mayManage", () => {
  test("asks the acting organization's role, and nothing else", () => {
    expect(mayManage(acting("acme", ["repos:manage"]), "repos:manage")).toBe(true);
    expect(mayManage(acting("acme", ["members:manage"]), "repos:manage")).toBe(false);
    expect(mayManage(null, "repos:manage")).toBe(false);
    expect(mayManage(acting("acme", ["repos:manage"]), undefined)).toBe(false);
  });
});
