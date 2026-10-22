// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { closeConsole } from "./closeConsole";
import { readConsoleGate } from "./consoleGate";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-close-console-"));
  await mkdir(join(dir, "apps/app/src"), { recursive: true });
  await writeFile(join(dir, "apps/app/src/index.ts"), "");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const STARTER = `{
  // Biome for both lint and format.
  "files": { "ignoreUnknown": true },
  "linter": {
    "enabled": true,
    "rules": { "preset": "recommended" }
  }
}
`;

describe("closeConsole", () => {
  test("scaffolds suspicious/noConsole into biome.jsonc, keeping its comments, and the gate reads enforced", async () => {
    await writeFile(join(dir, "biome.jsonc"), STARTER);
    const result = await closeConsole(dir);
    expect(result).toMatchObject({ written: true, gate: { state: "enforced", file: "biome.jsonc" } });
    const text = await readFile(join(dir, "biome.jsonc"), "utf8");
    expect(text).toContain("// Biome for both lint and format.");
    expect(text).toContain('"noConsole": "error"');
    expect((await readConsoleGate(dir)).state).toBe("enforced");
  });

  test("is idempotent: a project already enforcing writes nothing", async () => {
    await writeFile(join(dir, "biome.jsonc"), STARTER);
    await closeConsole(dir);
    const once = await readFile(join(dir, "biome.jsonc"), "utf8");
    expect((await closeConsole(dir)).written).toBe(false);
    expect(await readFile(join(dir, "biome.jsonc"), "utf8")).toBe(once);
  });

  test("never overrides a rule the adopter turned down on purpose, and says so", async () => {
    const turnedDown = '{ "linter": { "rules": { "suspicious": { "noConsole": "warn" } } } }\n';
    await writeFile(join(dir, "biome.jsonc"), turnedDown);
    const result = await closeConsole(dir);
    expect(result).toMatchObject({ written: false, gate: { state: "off" } });
    expect(await readFile(join(dir, "biome.jsonc"), "utf8")).toBe(turnedDown);
  });

  test("creates no Biome config where there is none, and reports the gate unverifiable", async () => {
    const result = await closeConsole(dir);
    expect(result).toMatchObject({ written: false, gate: { state: "unverifiable", file: null } });
  });
});
