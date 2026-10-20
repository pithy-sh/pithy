// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

describe("consoleGateOf, read for the files the rule must cover", () => {
  const rule = (level: unknown) => ({ rules: { suspicious: { noConsole: level } } });

  test("is not enforced by an override at `error` that covers no Worker source", () => {
    const gate = consoleGateOf({ overrides: [{ includes: ["scripts/**"], linter: rule("error") }] }, "biome.jsonc");
    expect(gate).toMatchObject({ state: "off", cause: "unstated" });
  });

  test("stays enforced when an override lowers the rule only on files that are not Worker source", () => {
    const config = {
      linter: rule("error"),
      overrides: [{ includes: ["**/*.test.ts"], linter: rule("off") }],
    };
    expect(consoleGateOf(config, "biome.jsonc").state).toBe("enforced");
  });

  test("is off when the rule allows any console method", () => {
    const gate = consoleGateOf({ linter: rule({ level: "error", options: { allow: ["log"] } }) }, "biome.jsonc");
    expect(gate).toMatchObject({ state: "off", cause: "lowered" });
    expect(gate.state === "off" && gate.reason).toContain("log");
  });

  test("is off when an override covering Worker source disables the linter", () => {
    const config = { linter: rule("error"), overrides: [{ includes: ["apps/**"], linter: { enabled: false } }] };
    expect(consoleGateOf(config, "biome.jsonc")).toMatchObject({ state: "off", cause: "disabled" });
  });

  test("is off when files or linter includes leave Worker source unlinted", () => {
    const files = { files: { includes: ["packages/**"] }, linter: rule("error") };
    expect(consoleGateOf(files, "biome.jsonc")).toMatchObject({ state: "off", cause: "disabled" });
    const linter = { linter: { includes: ["**", "!apps/**"], ...rule("error") } };
    expect(consoleGateOf(linter, "biome.jsonc")).toMatchObject({ state: "off", cause: "disabled" });
    const covered = { files: { includes: ["**", "!**/dist"] }, linter: rule("error") };
    expect(consoleGateOf(covered, "biome.jsonc").state).toBe("enforced");
  });

  test("is unverifiable, never enforced, for a glob it cannot read the way Biome does", () => {
    const config = { linter: rule("error"), overrides: [{ includes: ["apps/{api,web}/**"], linter: rule("off") }] };
    expect(consoleGateOf(config, "biome.jsonc").state).toBe("unverifiable");
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

  test("reads the gate for each Worker source file there is, so a lowered subdirectory is found", async () => {
    await mkdir(join(dir, "apps/api/src/legacy"), { recursive: true });
    await writeFile(join(dir, "apps/api/src/index.ts"), "");
    await writeFile(join(dir, "apps/api/src/legacy/old.ts"), "");
    const config = {
      linter: { rules: { suspicious: { noConsole: "error" } } },
      overrides: [{ includes: ["apps/api/src/legacy/**"], linter: { rules: { suspicious: { noConsole: "off" } } } }],
    };
    await writeFile(join(dir, "biome.jsonc"), JSON.stringify(config));
    const gate = await readConsoleGate(dir);
    expect(gate).toMatchObject({ state: "off", cause: "lowered" });
    expect(gate.state === "off" && gate.reason).toContain("apps/api/src/legacy/old.ts");
  });

  test("is unverifiable when a Worker holds a nested Biome config Pithy does not read", async () => {
    await mkdir(join(dir, "apps/api/src"), { recursive: true });
    await writeFile(join(dir, "apps/api/src/index.ts"), "");
    await writeFile(join(dir, "biome.jsonc"), JSON.stringify({ overrides: [NO_CONSOLE_OVERRIDE] }));
    await writeFile(join(dir, "apps/api/biome.jsonc"), JSON.stringify({ root: false, linter: { enabled: false } }));
    const gate = await readConsoleGate(dir);
    expect(gate).toMatchObject({ state: "unverifiable", file: "apps/api/biome.jsonc" });
  });
});
