// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createLogger, type LogSink } from "@pithy-sh/core/src/logger/logger";
import type { LogRecord } from "@pithy-sh/core/src/logger/record";
import { describe, expect, test } from "vitest";
import type { OrganizationCapability } from "../capability";
import { ORGANIZATION_PURGE_BINDING, ORGANIZATION_PURGE_KEY } from "./specs";
import { organizationPurgeInstanceId } from "./start";
import { lifecycleFor, organizationPurgeStarter } from "./workflow";

/** How the daily pass starts one organization's purge, and what it reports when it cannot. */

const DUE = { organizationId: "11111111-1111-4111-8111-111111111111", deletedAt: 1_000 };
const AT = new Date("2026-10-20T12:00:00.000Z");

function capture() {
  const records: LogRecord[] = [];
  const sink: LogSink = (record) => records.push(record);
  return { records, log: createLogger({ level: "debug", sink, now: () => 1 }) };
}

function binding(refuse?: Error) {
  const ids: string[] = [];
  return {
    ids,
    create: async (instance?: { id?: string }) => {
      if (refuse) throw refuse;
      const id = instance?.id ?? "";
      if (ids.includes(id)) throw new Error(`instance.already_exists: ${id}`);
      ids.push(id);
    },
    get: async (id: string) => {
      if (!ids.includes(id)) throw new Error(`instance.not_found: ${id}`);
      return { id };
    },
  };
}

describe("organizationPurgeStarter", () => {
  test("starts the purge under the id its deletion names, and says it did", async () => {
    const { records, log } = capture();
    const bound = binding();
    expect(await organizationPurgeStarter({ [ORGANIZATION_PURGE_BINDING]: bound }, log, () => AT)(DUE)).toBe(true);
    expect(bound.ids).toEqual([await organizationPurgeInstanceId({ ...DUE, at: AT })]);
    expect(records).toEqual([]);
  });

  test("a purge already started under that id is running, and counts", async () => {
    const { log } = capture();
    const bound = binding();
    const start = organizationPurgeStarter({ [ORGANIZATION_PURGE_BINDING]: bound }, log, () => AT);
    await start(DUE);
    expect(await start(DUE)).toBe(true);
    expect(bound.ids).toHaveLength(1);
  });

  test("with the binding absent, or a create refused, it starts nothing, says so, and logs why", async () => {
    const { records, log } = capture();
    expect(await organizationPurgeStarter({}, log, () => AT)(DUE)).toBe(false);
    const refused = binding(new Error("workflow quota exceeded"));
    expect(await organizationPurgeStarter({ [ORGANIZATION_PURGE_BINDING]: refused }, log, () => AT)(DUE)).toBe(false);
    expect(records.map((record) => [record.level, record.msg, record.fields?.workflow])).toEqual([
      ["warn", "workflow skipped", ORGANIZATION_PURGE_KEY],
      ["warn", "workflow skipped", ORGANIZATION_PURGE_KEY],
    ]);
    expect(String(records[0]?.fields?.reason)).toMatch(/binding absent/);
    expect(records[1]?.fields?.reason).toBe("workflow quota exceeded");
  });
});

describe("lifecycleFor", () => {
  test("hands the hooks the Workflow's env and no waitUntil, since a Workflow has no ExecutionContext", () => {
    const { log } = capture();
    const onOrganizationPurged = (): void => {};
    const organization = {
      organizationLifecycleHooks: { onOrganizationPurged },
    } as unknown as OrganizationCapability;
    const env = { DB: {}, MARKER: "workflow" };
    const deps = lifecycleFor(organization, env, log);
    expect(deps.hooks.onOrganizationPurged).toBe(onOrganizationPurged);
    expect(deps.runtime.env).toBe(env);
    expect("waitUntil" in deps.runtime).toBe(false);
  });
});
