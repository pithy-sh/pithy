// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type DevState, devStatePath, readDevState, removeDevState, writeDevState } from "./state";

describe("dev state", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-dev-state-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sample = (pid: number): DevState => ({
    pid,
    startedAt: "2026-07-27T00:00:00.000Z",
    childPids: [11, 22],
    workers: { api: { port: 8787, pid: 11 }, web: { port: 8788, pid: 22 } },
  });

  test("round-trips through write and read", async () => {
    const path = devStatePath(dir);
    await writeDevState(path, sample(1000));
    expect(await readDevState(path)).toEqual(sample(1000));
  });

  test("readDevState returns null when the file is absent or corrupt", async () => {
    const path = devStatePath(dir);
    expect(await readDevState(path)).toBeNull();
    await writeFile(path, "{ not json");
    expect(await readDevState(path)).toBeNull();
  });

  test("removeDevState deletes the file only when the pid is ours", async () => {
    const path = devStatePath(dir);
    await writeDevState(path, sample(1000));

    removeDevState(path, 2000); // a different (newer) owner — must not delete
    expect(existsSync(path)).toBe(true);

    removeDevState(path, 1000); // ours — delete
    expect(existsSync(path)).toBe(false);
  });
});

/**
 * **A session's own state file must not report its problems as a Zod issue array.**
 *
 * `pithy dev` wrote `port: 0` for a worker started from a parked row, and `DevState.parse` refused it —
 * correctly. What the operator saw was the raw `[{ "origin": "number", "code": "too_small", ... }]`
 * dump, in the middle of a starting session, with no sentence saying what it was or what to do. That is
 * what `fromZodError` exists for: every other boundary in this CLI maps a `ZodError` into a `PithyError`
 * with a problem line and an action line (`project/config.ts`), and this one did not.
 *
 * The shape bug is fixed where it belongs (`dev/orchestrator.ts` reads the port from the whole dev set,
 * not from the subset the run spawned). This is the other half: whatever goes wrong next, it reads.
 */
describe("writeDevState — a state it cannot write", () => {
  test("refuses an impossible port with a sentence, not a Zod dump", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "pithy-devstate-")), ".dev-state.json");
    const broken = {
      pid: 4242,
      startedAt: "2026-07-27T00:00:00.000Z",
      childPids: [5001],
      workers: { secrets: { port: 0, pid: 5001 } },
    } as unknown as DevState;

    await expect(writeDevState(path, broken)).rejects.toMatchObject({
      payload: { code: "validation/invalid_input" },
    });
  });

  test("the message names the worker and the field, and carries no JSON", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "pithy-devstate-")), ".dev-state.json");
    const broken = {
      pid: 4242,
      startedAt: "2026-07-27T00:00:00.000Z",
      childPids: [5001],
      workers: { secrets: { port: 0, pid: 5001 } },
    } as unknown as DevState;

    const error = await writeDevState(path, broken).catch((raised: unknown) => raised);
    const payload = (error as { payload: { message: string; action?: string } }).payload;
    expect(payload.message).toContain("secrets");
    expect(payload.message).toContain("port");
    expect(payload.message).not.toContain('"code"');
    expect(payload.action).toBeTruthy();
  });

  test("a valid state still writes", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "pithy-devstate-")), ".dev-state.json");
    await writeDevState(path, {
      pid: 4242,
      startedAt: "2026-07-27T00:00:00.000Z",
      childPids: [5001],
      workers: { secrets: { port: 8791, pid: 5001 } },
    });
    expect(await readDevState(path)).toMatchObject({ workers: { secrets: { port: 8791 } } });
  });
});
