// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { AccessCaller, PermissionHook } from "@pithy-sh/core/src/access/access";
import type { RecordVisibility } from "@pithy-sh/core/src/access/visibility";
import { beforeEach, describe, expect, test } from "vitest";
import { caller, makeDeps, resetMediaTables } from "../test-utils/harness";
import {
  createMedia,
  deleteMedia,
  finalizeMedia,
  getMedia,
  listMedia,
  MEDIA_MANAGE_POWER,
  updateMedia,
} from "./handlers";
import type { CreateMediaInput } from "./schemas";

/**
 * Who may reach a media record: the visibility levels, the not-found rule, the manage power, and the
 * permission hook — each asserted on get, list and delete.
 */

const OWNER = caller("owner", "org-a");
const OWNER_ELSEWHERE = caller("owner", "org-b");
const OWNER_NOWHERE = caller("owner");
const COLLEAGUE = caller("colleague", "org-a");
const MANAGER = caller("manager", "org-a", MEDIA_MANAGE_POWER);
const OUTSIDER = caller("outsider", "org-b", MEDIA_MANAGE_POWER);
const ANONYMOUS = caller(null);

const body: CreateMediaInput = {
  type: "image",
  name: "photo",
  filename: "a.png",
  contentType: "image/png",
  size: 10,
};

beforeEach(() => resetMediaTables(env.DB));

/** A stored record the owner made, at a visibility, acting for org-a. */
async function recordAt(visibility: RecordVisibility): Promise<string> {
  const deps = makeDeps(env.DB, OWNER);
  const { id } = await createMedia(deps, { ...body, visibility });
  await finalizeMedia(deps, id, {});
  return id;
}

/** What one caller's get says: the record id, or the error code. */
async function getAs(who: AccessCaller, id: string, hook?: PermissionHook): Promise<string> {
  try {
    return (await getMedia(makeDeps(env.DB, who, hook ? { permission: hook } : {}), id)).id;
  } catch (error) {
    return (error as { payload: { code: string } }).payload.code;
  }
}

/** What one caller's delete says. */
async function deleteAs(who: AccessCaller, id: string, hook?: PermissionHook): Promise<string> {
  try {
    await deleteMedia(makeDeps(env.DB, who, hook ? { permission: hook } : {}), id);
    return "deleted";
  } catch (error) {
    return (error as { payload: { code: string } }).payload.code;
  }
}

/** The ids one caller's list returns. */
async function listAs(who: AccessCaller, query: { includePublic?: "true" | "false" } = {}, hook?: PermissionHook) {
  const page = await listMedia(makeDeps(env.DB, who, hook ? { permission: hook } : {}), query);
  return page.items.map((item) => item.id);
}

describe("a private record is not found — not forbidden — to anyone but its owner, acting for its organization", () => {
  for (const [name, who] of [
    ["another user", COLLEAGUE],
    ["its owner acting for another organization", OWNER_ELSEWHERE],
    ["its owner acting for no organization", OWNER_NOWHERE],
    ["an anonymous caller", ANONYMOUS],
  ] as const) {
    test(`${name}: get and delete answer not found, and list does not include it`, async () => {
      const id = await recordAt("private");
      expect(await getAs(who, id)).toBe("media/not_found");
      expect(await deleteAs(who, id)).toBe("media/not_found");
      if (who.userId !== null) expect(await listAs(who, { includePublic: "true" })).not.toContain(id);
      // Still there — nothing above touched it.
      expect(await getAs(OWNER, id)).toBe(id);
    });
  }

  test("its owner reads, lists and deletes it", async () => {
    const id = await recordAt("private");
    expect(await getAs(OWNER, id)).toBe(id);
    expect(await listAs(OWNER)).toEqual([id]);
    expect(await deleteAs(OWNER, id)).toBe("deleted");
  });
});

describe("an organization record", () => {
  test("is readable by a member acting for that organization, and listed for them", async () => {
    const id = await recordAt("organization");
    expect(await getAs(COLLEAGUE, id)).toBe(id);
    expect(await listAs(COLLEAGUE)).toEqual([id]);
  });

  test("is not found for anyone else", async () => {
    const id = await recordAt("organization");
    for (const who of [OWNER_ELSEWHERE, OUTSIDER, ANONYMOUS]) expect(await getAs(who, id)).toBe("media/not_found");
    expect(await listAs(OUTSIDER, { includePublic: "true" })).not.toContain(id);
  });

  test("a member who may read it may not change it — forbidden, because they already know it exists", async () => {
    const id = await recordAt("organization");
    expect(await deleteAs(COLLEAGUE, id)).toBe("media/forbidden");
    await expect(updateMedia(makeDeps(env.DB, COLLEAGUE), id, { name: "renamed" })).rejects.toMatchObject({
      payload: { code: "media/forbidden", status: 403 },
    });
  });
});

describe("a public record", () => {
  test("is readable without signing in", async () => {
    const id = await recordAt("public");
    expect(await getAs(ANONYMOUS, id)).toBe(id);
    expect(await getAs(OUTSIDER, id)).toBe(id);
  });

  test("is not anybody's to change but its owner's or a manager's", async () => {
    const id = await recordAt("public");
    expect(await deleteAs(OUTSIDER, id)).toBe("media/forbidden");
    expect(await deleteAs(OWNER_ELSEWHERE, id)).toBe("media/forbidden");
  });
});

describe("the manage power", () => {
  test("a role holding media:manage edits, re-scopes and deletes any record in its own organization", async () => {
    const id = await recordAt("private");
    const deps = makeDeps(env.DB, MANAGER);
    expect((await updateMedia(deps, id, { name: "cleaned up" })).name).toBe("cleaned up");
    expect((await updateMedia(deps, id, { visibility: "organization" })).visibility).toBe("organization");
    expect(await deleteAs(MANAGER, id)).toBe("deleted");
  });

  test("and lists every record in it", async () => {
    const id = await recordAt("private");
    expect(await listAs(MANAGER)).toEqual([id]);
  });

  test("holding it in another organization reaches nothing here", async () => {
    const id = await recordAt("private");
    expect(await getAs(OUTSIDER, id)).toBe("media/not_found");
    expect(await deleteAs(OUTSIDER, id)).toBe("media/not_found");
  });
});

describe("a list", () => {
  test("returns the caller's own records and their organization's — and public ones only when asked", async () => {
    const own = await recordAt("private");
    const shared = await recordAt("organization");
    const published = await recordAt("public");
    // Another organization's public record: never listed unless includePublic.
    const outside = makeDeps(env.DB, OUTSIDER);
    const { id: elsewhere } = await createMedia(outside, { ...body, visibility: "public" });

    expect((await listAs(OWNER)).sort()).toEqual([own, shared, published].sort());
    expect((await listAs(COLLEAGUE)).sort()).toEqual([shared, published].sort());
    expect(await listAs(COLLEAGUE)).not.toContain(elsewhere);
    expect(await listAs(COLLEAGUE, { includePublic: "true" })).toContain(elsewhere);
    expect(await listAs(COLLEAGUE, { includePublic: "false" })).not.toContain(elsewhere);
  });
});

describe("the permission hook", () => {
  test("no hook leaves the rules unchanged", async () => {
    const id = await recordAt("private");
    expect(await getAs(COLLEAGUE, id)).toBe("media/not_found");
    expect(await getAs(OWNER, id)).toBe(id);
  });

  test("an allow admits a record by id — sharing it with one person", async () => {
    const id = await recordAt("private");
    const share: PermissionHook = ({ record, caller: who, action }) =>
      record.id === id && who.userId === "colleague" && action === "read" ? "allow" : "default";
    expect(await getAs(COLLEAGUE, id, share)).toBe(id);
    // Read, not write: the grant was for reading.
    expect(await deleteAs(COLLEAGUE, id, share)).toBe("media/forbidden");
  });

  test("a grant does not list — the adopter lists their own grants from their own tables", async () => {
    const id = await recordAt("private");
    const share: PermissionHook = () => "allow";
    expect(await listAs(COLLEAGUE, {}, share)).not.toContain(id);
  });

  test("a deny removes a record from get, list and delete — a legal hold", async () => {
    const id = await recordAt("private");
    const hold: PermissionHook = ({ record }) => (record.id === id ? "deny" : "default");
    expect(await getAs(OWNER, id, hold)).toBe("media/not_found");
    expect(await listAs(OWNER, {}, hold)).not.toContain(id);
    expect(await deleteAs(OWNER, id, hold)).toBe("media/not_found");
    expect(await getAs(OWNER, id)).toBe(id);
  });

  test("a page the hook shortens still says there is more, in its cursor", async () => {
    for (let at = 0; at < 3; at += 1) await recordAt("private");
    const order = (await listMedia(makeDeps(env.DB, OWNER), {})).items.map((item) => item.id);
    expect(order).toHaveLength(3);

    // A hold on the first record of the first page: that page comes back short, and still says there is more.
    const holdFirst: PermissionHook = ({ record }) => (record.id === order[0] ? "deny" : "default");
    const short = await listMedia(makeDeps(env.DB, OWNER, { permission: holdFirst }), { limit: 2 });
    expect(short.items.map((item) => item.id)).toEqual([order[1]]);
    expect(short.cursor).toBeDefined();

    // A hold on the last record: the last page is empty, and the cursor says it is the last.
    const holdLast: PermissionHook = ({ record }) => (record.id === order[2] ? "deny" : "default");
    const deps = makeDeps(env.DB, OWNER, { permission: holdLast });
    const page = await listMedia(deps, { limit: 2 });
    const next = await listMedia(deps, { limit: 2, cursor: page.cursor });
    expect(next.items).toEqual([]);
    expect(next.cursor).toBeUndefined();
  });
});

describe("edits", () => {
  test("the owner renames and re-scopes their own record", async () => {
    const id = await recordAt("private");
    const deps = makeDeps(env.DB, OWNER);
    expect((await updateMedia(deps, id, { name: "renamed" })).name).toBe("renamed");
    expect((await updateMedia(deps, id, { visibility: "organization" })).visibility).toBe("organization");
  });

  test("a visibility change outside visibility.allowed is refused", async () => {
    const id = await recordAt("private");
    const deps = makeDeps(env.DB, OWNER, { config: { visibility: { allowed: ["private", "organization"] } } });
    await expect(updateMedia(deps, id, { visibility: "public" })).rejects.toMatchObject({
      payload: { code: "validation/invalid_input" },
    });
  });

  test("organization visibility on a record written with no organization is refused", async () => {
    const deps = makeDeps(env.DB, OWNER_NOWHERE);
    const { id } = await createMedia(deps, body);
    await expect(updateMedia(deps, id, { visibility: "organization" })).rejects.toMatchObject({
      payload: { code: "validation/invalid_input" },
    });
  });
});
