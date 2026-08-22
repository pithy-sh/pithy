// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StatePathOptions } from "../notifier/state";
import { checkPortsRegistry, describePortsRegistry } from "./portsRegistry";

describe("checkPortsRegistry", () => {
  let dir: string;
  let configDir: string;
  let projectDir: string;

  const paths = (): StatePathOptions => ({ env: { PITHY_CONFIG_DIR: configDir }, platform: "linux" });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-doctor-ports-"));
    configDir = join(dir, "config");
    projectDir = join(dir, "project");
    await mkdir(configDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves the path even with no file, because where it would go is the answer", async () => {
    const check = await checkPortsRegistry(projectDir, paths());

    expect(check.path).toBe(join(configDir, "dev-ports.json"));
    expect(check.present).toBe(false);
    expect(check.stray).toBeNull();
    expect(describePortsRegistry(check)).toMatch(/no file yet/i);
  });

  it("reports the file once it is there, and then has nothing to add", async () => {
    await writeFile(join(configDir, "dev-ports.json"), "{}", "utf8");

    const check = await checkPortsRegistry(projectDir, paths());

    expect(check.present).toBe(true);
    // A healthy location needs no verdict — the path is the whole line.
    expect(describePortsRegistry(check)).toBeNull();
  });

  it("names a .dev-ports.json an older CLI left in the checkout", async () => {
    // The one state a developer cannot diagnose alone: the file they can see is not the file in use, and
    // editing it changes nothing (#435).
    const stray = join(projectDir, ".dev-ports.json");
    await writeFile(stray, "{}", "utf8");
    await writeFile(join(configDir, "dev-ports.json"), "{}", "utf8");

    const check = await checkPortsRegistry(projectDir, paths());

    expect(check.stray).toBe(stray);
    expect(describePortsRegistry(check)).toContain(stray);
  });

  it("says nothing about a directory that merely shares the name", async () => {
    await mkdir(join(projectDir, ".dev-ports.json"));

    expect((await checkPortsRegistry(projectDir, paths())).stray).toBeNull();
  });

  it("never throws, whatever the config directory turns out to be", async () => {
    // A probe that can fail the command it is diagnosing is worse than one that says less.
    const blocked = join(dir, "not-a-directory");
    await writeFile(blocked, "", "utf8");

    await expect(
      checkPortsRegistry(join(blocked, "nope"), {
        env: { PITHY_CONFIG_DIR: join(blocked, "nope") },
        platform: "linux",
      }),
    ).resolves.toMatchObject({ present: false, stray: null });
  });
});
