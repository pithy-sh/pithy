// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { consoleGateOf, NO_CONSOLE_OVERRIDE, readConsoleGate } from "./consoleGate";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-console-gate-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("consoleGateOf", () => {
  test("is enforced when the rule is `error` at the top level", () => {
    expect(consoleGateOf({ linter: { rules: { suspicious: { noConsole: "error" } } } }, "biome.jsonc")).toEqual({
      state: "enforced",
      file: "biome.jsonc",
    });
  });

  test("is enforced by the override `pithy privacy enable` writes, and by the object form", () => {
    expect(consoleGateOf({ overrides: [NO_CONSOLE_OVERRIDE] }, "biome.jsonc").state).toBe("enforced");
    expect(
      consoleGateOf({ linter: { rules: { suspicious: { noConsole: { level: "error" } } } } }, "biome.jsonc").state,
    ).toBe("enforced");
  });

  test("is off when the rule is never set, naming the rule and the file", () => {
    const gate = consoleGateOf({ linter: { rules: { preset: "recommended" } } }, "biome.jsonc");
    expect(gate).toMatchObject({ state: "off", file: "biome.jsonc" });
    expect(gate.state === "off" && gate.reason).toContain("suspicious/noConsole");
  });

  test("is off when the rule is a warning, because a warning fails nothing", () => {
    const gate = consoleGateOf({ linter: { rules: { suspicious: { noConsole: "warn" } } } }, "biome.json");
    expect(gate.state).toBe("off");
    expect(gate.state === "off" && gate.reason).toContain("warn");
  });

  test("is off when an override turns the rule back off, or the linter is disabled", () => {
    expect(
      consoleGateOf(
        {
          linter: { rules: { suspicious: { noConsole: "error" } } },
          overrides: [{ includes: ["apps/**"], linter: { rules: { suspicious: { noConsole: "off" } } } }],
        },
        "biome.jsonc",
      ).state,
    ).toBe("off");
    expect(
      consoleGateOf({ linter: { enabled: false, rules: { suspicious: { noConsole: "error" } } } }, "biome.jsonc").state,
    ).toBe("off");
    expect(consoleGateOf({ linter: { rules: { suspicious: "off" } } }, "biome.jsonc").state).toBe("off");
  });

  test("is unverifiable, never enforced, for a config that extends one it does not state", () => {
    const gate = consoleGateOf({ extends: ["./shared/biome.jsonc"] }, "biome.jsonc");
    expect(gate.state).toBe("unverifiable");
  });

  test("an `extends` with the rule stated locally is still enforced", () => {
    expect(
      consoleGateOf(
        { extends: ["./shared.jsonc"], linter: { rules: { suspicious: { noConsole: "error" } } } },
        "biome.jsonc",
      ).state,
    ).toBe("enforced");
  });
});

describe("readConsoleGate", () => {
  test("reads biome.jsonc at the project root, comments and all", async () => {
    await writeFile(
      join(dir, "biome.jsonc"),
      '{\n  // the gate\n  "linter": { "rules": { "suspicious": { "noConsole": "error" } } }\n}\n',
    );
    expect(await readConsoleGate(dir)).toEqual({ state: "enforced", file: "biome.jsonc" });
  });

  test("reads biome.json too", async () => {
    await writeFile(join(dir, "biome.json"), JSON.stringify({ linter: { rules: {} } }));
    expect((await readConsoleGate(dir)).state).toBe("off");
  });

  test("is unverifiable with no Biome config, and says so", async () => {
    const gate = await readConsoleGate(dir);
    expect(gate).toMatchObject({ state: "unverifiable", file: null });
    expect(gate.state === "unverifiable" && gate.reason).toContain("No biome.json or biome.jsonc");
  });

  test("deleting biome.jsonc moves the gate from enforced to unverifiable, never back to passing", async () => {
    await writeFile(join(dir, "biome.jsonc"), JSON.stringify({ overrides: [NO_CONSOLE_OVERRIDE] }));
    expect((await readConsoleGate(dir)).state).toBe("enforced");
    await rm(join(dir, "biome.jsonc"));
    expect((await readConsoleGate(dir)).state).toBe("unverifiable");
  });

  test("is unverifiable for a config that does not parse, and for two configs at once", async () => {
    await writeFile(join(dir, "biome.jsonc"), "{ not json");
    expect((await readConsoleGate(dir)).state).toBe("unverifiable");
    await writeFile(join(dir, "biome.jsonc"), "{}");
    await writeFile(join(dir, "biome.json"), "{}");
    const gate = await readConsoleGate(dir);
    expect(gate.state).toBe("unverifiable");
    expect(gate.state === "unverifiable" && gate.reason).toContain("both");
  });
});
