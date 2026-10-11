// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { requireWindows } from "../test-utils/windows";
import { devLogBranch, devLogFile, parseDevLogFileName } from "./devLogPath";

requireWindows();

/**
 * **A session log is filed for a branch whose name Windows cannot use in a filename** (#671).
 *
 * git allows `<`, `>` and `|` in a branch name; Windows refuses all three in a filename. `devLogPath.ts`
 * replaces them, and said before #702 that this was kept "by construction rather than by a test", because
 * nothing here ran on Windows. This writes the file Windows would otherwise refuse, reads the directory
 * back, and parses the name — and first proves the refusal is real, so the pass means something.
 */

const BRANCH = "feature/1-a<b>|c";

let configDir: string;

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), "pithy-logs-"));
});

afterAll(async () => {
  if (configDir) await rm(configDir, { recursive: true, force: true });
});

describe("a session log on Windows", () => {
  test("Windows refuses the branch name as a filename", async () => {
    await expect(writeFile(join(configDir, "dev.a<b>|c.api.jsonl"), "")).rejects.toThrow();
  });

  test("is written under the made-safe name, and reads back as the branch and worker", async () => {
    const file = devLogFile(
      { project: "acme", branch: BRANCH, worker: "api" },
      { env: { PITHY_CONFIG_DIR: configDir } },
    );
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "{}\n");

    const [name] = await readdir(dirname(file));
    expect(name).toBeDefined();
    expect(parseDevLogFileName(name ?? "")).toEqual({ branch: devLogBranch(BRANCH), worker: "api" });
  });
});
