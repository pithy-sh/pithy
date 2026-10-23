// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { organizationPurgeInstanceId, startOrganizationPurgeInstance } from "./start";

const ACME = "11111111-1111-4111-8111-111111111111";
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

describe("organizationPurgeInstanceId", () => {
  test("names one instance per deletion per UTC day, inside the platform's id rule", async () => {
    const a = await organizationPurgeInstanceId({ organizationId: ACME, deletedAt: 1_000, at: DAY_ONE });
    expect(a).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_-]*$/);
    expect(a.length).toBeLessThanOrEqual(100);
    expect(await organizationPurgeInstanceId({ organizationId: ACME, deletedAt: 1_000, at: LATER_DAY_ONE })).toBe(a);
    expect(await organizationPurgeInstanceId({ organizationId: ACME, deletedAt: 1_000, at: DAY_TWO })).not.toBe(a);
    // A restored and re-deleted organization is a different purge.
    expect(await organizationPurgeInstanceId({ organizationId: ACME, deletedAt: 2_000, at: DAY_ONE })).not.toBe(a);
    // And the id says nothing about which organization it is.
    expect(a).not.toContain(ACME);
  });
});

describe("startOrganizationPurgeInstance", () => {
  test("creates the instance with the organization as its parameters", async () => {
    const bound = binding();
    await startOrganizationPurgeInstance(bound, { organizationId: ACME, deletedAt: 1_000, at: DAY_ONE });
    expect(bound.created).toEqual([
      {
        id: await organizationPurgeInstanceId({ organizationId: ACME, deletedAt: 1_000, at: DAY_ONE }),
        params: { organizationId: ACME },
      },
    ]);
  });

  test("a second start of the same purge finds it started and succeeds", async () => {
    const bound = binding();
    const start = { organizationId: ACME, deletedAt: 1_000, at: DAY_ONE };
    await startOrganizationPurgeInstance(bound, start);
    await expect(startOrganizationPurgeInstance(bound, start)).resolves.toBeUndefined();
    expect(bound.ids).toHaveLength(1);
  });

  test("any other refusal is thrown, and so is a duplicate a binding cannot look up", async () => {
    await expect(
      startOrganizationPurgeInstance(binding({ refuse: new Error("quota") }), {
        organizationId: ACME,
        deletedAt: 1_000,
        at: DAY_ONE,
      }),
    ).rejects.toThrow("quota");
    const blind = binding({ lookUp: false });
    const start = { organizationId: ACME, deletedAt: 1_000, at: DAY_ONE };
    await startOrganizationPurgeInstance(blind, start);
    await expect(startOrganizationPurgeInstance(blind, start)).rejects.toThrow("instance.already_exists");
  });
});
