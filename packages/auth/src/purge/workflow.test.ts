// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { createLogger, type LogSink } from "@pithy-sh/core/src/logger/logger";
import type { LogRecord } from "@pithy-sh/core/src/logger/record";
import { describe, expect, test } from "vitest";
import { AUTH_PURGE_BINDING, AUTH_PURGE_KEY } from "./specs";
import { purgeInstanceId } from "./start";
import { purgeStarter } from "./workflow";

/**
 * How the daily pass starts one account's purge (#622), and what it reports when it cannot. The pass counts what
 * this answers, so a purge it never started must answer `false`: an operator reading `{ started: 2 }` is told two
 * purges are running.
 */

const DUE = { userId: "u-1", deletedAt: 1_000 };
const AT = new Date("2026-10-20T12:00:00.000Z");

function capture() {
  const records: LogRecord[] = [];
  const sink: LogSink = (record) => records.push(record);
  return { records, log: createLogger({ level: "debug", sink, now: () => 1 }) };
}

/** A binding holding one instance per id, as Cloudflare's does, or refusing every create with `refuse`. */
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

describe("purgeStarter", () => {
  test("starts the purge under the id its deletion names, and says it did", async () => {
    const { records, log } = capture();
    const bound = binding();
    expect(await purgeStarter({ [AUTH_PURGE_BINDING]: bound }, log, () => AT)(DUE)).toBe(true);
    expect(bound.ids).toEqual([await purgeInstanceId({ ...DUE, at: AT })]);
    expect(records).toEqual([]);
  });

  test("a purge already started under that id is running, and counts", async () => {
    const { log } = capture();
    const bound = binding();
    const start = purgeStarter({ [AUTH_PURGE_BINDING]: bound }, log, () => AT);
    await start(DUE);
    expect(await start(DUE)).toBe(true);
    expect(bound.ids).toHaveLength(1);
  });

  test("with the binding absent it starts nothing, says so, and logs the skip rather than throwing", async () => {
    const { records, log } = capture();
    expect(await purgeStarter({}, log, () => AT)(DUE)).toBe(false);
    expect(await purgeStarter({ [AUTH_PURGE_BINDING]: { notABinding: true } }, log, () => AT)(DUE)).toBe(false);
    expect(records.map((record) => [record.level, record.msg, record.fields])).toEqual([
      ["warn", "workflow skipped", expect.objectContaining({ workflow: AUTH_PURGE_KEY, binding: AUTH_PURGE_BINDING })],
      ["warn", "workflow skipped", expect.objectContaining({ workflow: AUTH_PURGE_KEY, binding: AUTH_PURGE_BINDING })],
    ]);
    expect(String(records[0]?.fields?.reason)).toMatch(/binding absent/);
  });

  test("a create that fails for any reason but a duplicate starts nothing, says so, and logs why", async () => {
    const { records, log } = capture();
    const bound = binding(new Error("workflow quota exceeded"));
    expect(await purgeStarter({ [AUTH_PURGE_BINDING]: bound }, log, () => AT)(DUE)).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "warn",
      msg: "workflow skipped",
      fields: expect.objectContaining({ workflow: AUTH_PURGE_KEY, reason: "workflow quota exceeded" }),
    });
  });
});
