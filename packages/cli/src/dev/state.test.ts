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
