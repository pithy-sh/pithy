// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { purgeInstanceId, startPurgeInstance } from "./start";

const DAY_ONE = new Date("2026-10-20T01:59:00.000Z");
const LATER_DAY_ONE = new Date("2026-10-20T23:00:00.000Z");
const DAY_TWO = new Date("2026-10-21T02:00:00.000Z");

/** A binding holding one instance per id, as Cloudflare's does. */
function binding(options: { refuse?: Error; lookUp?: boolean } = {}) {
  const ids: string[] = [];
  const created: { id?: string; params?: unknown }[] = [];
  const base = {
    ids,
    created,
    create: async (instance?: { id?: string; params?: unknown }) => {
      if (options.refuse) throw options.refuse;
      const id = instance?.id ?? "";
      if (ids.includes(id)) throw new Error("instance.already_exists");
      ids.push(id);
      created.push(instance ?? {});
    },
  };
  if (options.lookUp === false) return base;
  return {
    ...base,
    get: async (id: string) => {
      if (!ids.includes(id)) throw new Error("instance.not_found");
      return {};
    },
  };
}

describe("purgeInstanceId", () => {
  test("names one instance per deletion per UTC day, inside the platform's id rule", async () => {
    const a = await purgeInstanceId({ userId: "u-1", deletedAt: 1_000, at: DAY_ONE });
    expect(a).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/);
    expect(a.length).toBeLessThanOrEqual(100);
    expect(a.endsWith("-20261020")).toBe(true);
    // The same deletion, the same day: the same instance.
    expect(await purgeInstanceId({ userId: "u-1", deletedAt: 1_000, at: LATER_DAY_ONE })).toBe(a);
    // Another day, another deletion of the account, or another account: another instance.
    expect(await purgeInstanceId({ userId: "u-1", deletedAt: 1_000, at: DAY_TWO })).not.toBe(a);
    expect(await purgeInstanceId({ userId: "u-1", deletedAt: 2_000, at: DAY_ONE })).not.toBe(a);
    expect(await purgeInstanceId({ userId: "u-2", deletedAt: 1_000, at: DAY_ONE })).not.toBe(a);
  });

  test("a user id the platform's rule would refuse still names a valid id, and is not in it", async () => {
    const id = await purgeInstanceId({ userId: `odd id/with:${"x".repeat(250)}`, deletedAt: 1, at: DAY_ONE });
    expect(id).toMatch(/^auth-purge-[0-9a-f]{40}-\d{8}$/);
    expect(id).not.toContain("odd");
  });
});

describe("startPurgeInstance", () => {
  test("creates the instance under its id, with the job's own parameters", async () => {
    const b = binding();
    await startPurgeInstance(b, { userId: "u-1", deletedAt: 1_000, notify: false, at: DAY_ONE });
    expect(b.created).toEqual([
      {
        id: await purgeInstanceId({ userId: "u-1", deletedAt: 1_000, at: DAY_ONE }),
        params: { userId: "u-1", notify: false },
      },
    ]);
  });

  test("a second start of the same purge finds the first and starts nothing", async () => {
    const b = binding();
    await startPurgeInstance(b, { userId: "u-1", deletedAt: 1_000, at: DAY_ONE });
    await expect(
      startPurgeInstance(b, { userId: "u-1", deletedAt: 1_000, at: LATER_DAY_ONE }),
    ).resolves.toBeUndefined();
    expect(b.created).toHaveLength(1);
  });

  test("any other refusal is thrown, so the caller reports the purge pending", async () => {
    await expect(
      startPurgeInstance(binding({ refuse: new Error("workflow not found") }), {
        userId: "u-1",
        deletedAt: 1,
        at: DAY_ONE,
      }),
    ).rejects.toThrow("workflow not found");
    // A binding that cannot look an instance up cannot tell a taken id from any other refusal.
    const b = binding({ lookUp: false });
    await startPurgeInstance(b, { userId: "u-1", deletedAt: 1, at: DAY_ONE });
    await expect(startPurgeInstance(b, { userId: "u-1", deletedAt: 1, at: DAY_ONE })).rejects.toThrow(
      "instance.already_exists",
    );
  });
});
