// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test, vi } from "vitest";
import {
  type AccessCaller,
  type AccessRecord,
  accessLevel,
  defaultAllows,
  keepReadable,
  type PermissionHook,
} from "./access";
import type { ActingOrganization } from "./acting";

/** An acting organization whose role holds exactly the powers named. */
function acting(organizationId: string, ...powers: string[]): ActingOrganization {
  return { organizationId, roleAllows: (power) => powers.includes(power) };
}

const owner: AccessCaller = { userId: "u-owner", acting: acting("org-a") };
const ownerElsewhere: AccessCaller = { userId: "u-owner", acting: acting("org-b") };
const ownerNowhere: AccessCaller = { userId: "u-owner", acting: null };
const colleague: AccessCaller = { userId: "u-colleague", acting: acting("org-a") };
const manager: AccessCaller = { userId: "u-manager", acting: acting("org-a", "media:manage") };
const outsider: AccessCaller = { userId: "u-outsider", acting: acting("org-b", "media:manage") };
const anonymous: AccessCaller = { userId: null, acting: null };

function record(visibility: AccessRecord["visibility"], organizationId: string | null = "org-a"): AccessRecord {
  return { id: "r1", ownerId: "u-owner", organizationId, visibility };
}

const MANAGE = "media:manage";

describe("defaultAllows — read", () => {
  test("a private record is the owner's, acting for the record's organization, and nobody else's", () => {
    const r = record("private");
    expect(defaultAllows("read", r, owner, MANAGE)).toBe(true);
    expect(defaultAllows("read", r, ownerElsewhere, MANAGE)).toBe(false);
    expect(defaultAllows("read", r, ownerNowhere, MANAGE)).toBe(false);
    expect(defaultAllows("read", r, colleague, MANAGE)).toBe(false);
    expect(defaultAllows("read", r, outsider, MANAGE)).toBe(false);
    expect(defaultAllows("read", r, anonymous, MANAGE)).toBe(false);
  });

  test("a private record written with no organization is its owner's only while no organization is in force", () => {
    const r = record("private", null);
    expect(defaultAllows("read", r, ownerNowhere, MANAGE)).toBe(true);
    expect(defaultAllows("read", r, owner, MANAGE)).toBe(false);
  });

  test("an organization record is any member's acting for it, and nobody else's", () => {
    const r = record("organization");
    expect(defaultAllows("read", r, colleague, MANAGE)).toBe(true);
    expect(defaultAllows("read", r, owner, MANAGE)).toBe(true);
    expect(defaultAllows("read", r, ownerElsewhere, MANAGE)).toBe(false);
    expect(defaultAllows("read", r, outsider, MANAGE)).toBe(false);
    expect(defaultAllows("read", r, anonymous, MANAGE)).toBe(false);
  });

  test("a public record is anyone's, signed in or not", () => {
    const r = record("public");
    expect(defaultAllows("read", r, anonymous, MANAGE)).toBe(true);
    expect(defaultAllows("read", r, outsider, MANAGE)).toBe(true);
  });

  test("the manage power in the record's organization admits a private record, and only there", () => {
    expect(defaultAllows("read", record("private"), manager, MANAGE)).toBe(true);
    expect(defaultAllows("read", record("private"), outsider, MANAGE)).toBe(false);
  });

  test("a system-owned record with no organization is nobody's — no power reaches it", () => {
    const system: AccessRecord = { id: "r0", ownerId: null, organizationId: null, visibility: "private" };
    for (const caller of [owner, manager, ownerNowhere, anonymous]) {
      expect(defaultAllows("read", system, caller, MANAGE)).toBe(false);
    }
  });
});

describe("defaultAllows — write", () => {
  test("the owner acting for the record's organization may write", () => {
    expect(defaultAllows("write", record("private"), owner, MANAGE)).toBe(true);
  });

  test("a member who may read an organization record may not write it", () => {
    expect(defaultAllows("write", record("organization"), colleague, MANAGE)).toBe(false);
  });

  test("the manage power writes in its own organization", () => {
    expect(defaultAllows("write", record("organization"), manager, MANAGE)).toBe(true);
  });

  test("a public record is not anybody's to write — not even its owner's, acting elsewhere", () => {
    expect(defaultAllows("write", record("public"), anonymous, MANAGE)).toBe(false);
    expect(defaultAllows("write", record("public"), ownerElsewhere, MANAGE)).toBe(false);
    expect(defaultAllows("write", record("public"), outsider, MANAGE)).toBe(false);
  });

  test("another capability's power does not write here", () => {
    const storageManager: AccessCaller = { userId: "u-x", acting: acting("org-a", "storage:manage") };
    expect(defaultAllows("write", record("organization"), storageManager, MANAGE)).toBe(false);
  });
});

describe("accessLevel — the hook", () => {
  const base = { capability: "media", managePower: MANAGE, env: {} };

  test("no hook is the rules above, unchanged", async () => {
    expect(await accessLevel({ ...base, record: record("private"), caller: owner })).toBe("write");
    expect(await accessLevel({ ...base, record: record("organization"), caller: colleague })).toBe("read");
    expect(await accessLevel({ ...base, record: record("private"), caller: colleague })).toBe("none");
  });

  test("an allow admits a record the rules would not", async () => {
    const hook = vi.fn(async () => "allow" as const);
    expect(await accessLevel({ ...base, record: record("private"), caller: colleague, hook })).toBe("write");
  });

  test("an allow on read alone admits reading and nothing more", async () => {
    const hook: PermissionHook = async ({ action }) => (action === "read" ? "allow" : "default");
    expect(await accessLevel({ ...base, record: record("private"), caller: colleague, hook })).toBe("read");
  });

  test("a deny removes a record the rules admit — a legal hold", async () => {
    const hook = async () => "deny" as const;
    expect(await accessLevel({ ...base, record: record("public"), caller: owner, hook })).toBe("none");
  });

  test("a deny on write alone leaves the record readable and refuses the change", async () => {
    const hook: PermissionHook = async ({ action }) => (action === "write" ? "deny" : "default");
    expect(await accessLevel({ ...base, record: record("private"), caller: owner, hook })).toBe("read");
  });

  test("the hook is told who is asking, for what, about which record, and is handed the env", async () => {
    const hook = vi.fn(async () => "default" as const);
    const env = { DB: "binding" };
    await accessLevel({ ...base, env, record: record("private"), caller: owner, hook });
    expect(hook).toHaveBeenCalledWith({
      action: "read",
      capability: "media",
      record: record("private"),
      caller: { userId: "u-owner", organizationId: "org-a" },
      env,
    });
  });

  test("write is never asked about a record the caller cannot read", async () => {
    const hook = vi.fn<PermissionHook>(async ({ action }) => (action === "read" ? "deny" : "allow"));
    expect(await accessLevel({ ...base, record: record("private"), caller: owner, hook })).toBe("none");
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

describe("keepReadable — a list asks the hook about each row on the page", () => {
  test("a deny filters a row; a grant cannot add one, because only the page is asked", async () => {
    const rows = [record("private"), { ...record("organization"), id: "r2" }];
    const hook: PermissionHook = async ({ record: r }) => (r.id === "r2" ? "deny" : "allow");
    const kept = await keepReadable(rows, { capability: "media", caller: owner, env: {}, hook });
    expect(kept.map((r) => r.id)).toEqual(["r1"]);
  });

  test("no hook keeps every row", async () => {
    const rows = [record("private")];
    expect(await keepReadable(rows, { capability: "media", caller: owner, env: {} })).toEqual(rows);
  });
});
