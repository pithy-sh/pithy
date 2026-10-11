// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { requireWindows } from "../test-utils/windows";
import { stateDir } from "./state";

requireWindows();

/**
 * **On Windows, Pithy keeps its per-machine files under `%APPDATA%\pithy`** — `dev.json`,
 * `secrets.jsonc`, `dev-ports.json`, the session logs (#131, #435).
 *
 * The resolver's other tests pass `"win32"` in on Linux. These let the platform answer for itself: one reads
 * the host's own `APPDATA`, as the CLI does, and one writes and reads a file at the path it gives, so a
 * Windows path that only looks right fails here. Expected paths are spelled with `\\`, not built with the
 * `join` the resolver itself uses, so the assertion is not the code agreeing with itself.
 */

let appData: string;

beforeAll(async () => {
  appData = await mkdtemp(join(tmpdir(), "pithy-appdata-"));
});

afterAll(async () => {
  if (appData) await rm(appData, { recursive: true, force: true });
});

describe("the config directory on Windows", () => {
  test("is the host's own %APPDATA%\\pithy when nothing overrides it", () => {
    const { PITHY_CONFIG_DIR: _override, ...hostEnv } = process.env;
    const hostAppData = process.env.APPDATA;
    expect(hostAppData, "a Windows host sets APPDATA").toBeTruthy();
    expect(stateDir({ env: hostEnv })).toBe(`${hostAppData}\\pithy`);
  });

  test("is %APPDATA%\\pithy, and a file written there reads back", async () => {
    const dir = stateDir({ env: { APPDATA: appData } });
    expect(dir).toBe(`${appData}\\pithy`);

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "dev.json"), "{}\n");
    expect(await readFile(join(dir, "dev.json"), "utf8")).toBe("{}\n");
  });

  test("PITHY_CONFIG_DIR still wins", () => {
    const override = join(appData, "elsewhere");
    expect(stateDir({ env: { APPDATA: appData, PITHY_CONFIG_DIR: override } })).toBe(override);
  });
});
