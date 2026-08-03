// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { MAX_ENVIRONMENT_NAME } from "@pithy-sh/core/src/naming/environment";
import { describe, expect, test } from "vitest";
import { ENV_ARG, requireEnvironment, requireManagedEnvironment } from "./environment";

const commandsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "commands");

describe("requireEnvironment", () => {
  test("returns each first-class environment unchanged", () => {
    for (const env of ["dev", "staging", "prod"]) expect(requireEnvironment(env)).toBe(env);
  });

  test("refuses the old spelling with the new one", () => {
    expect(() => requireEnvironment("production")).toThrow(PithyError);
    try {
      requireEnvironment("production");
      expect.unreachable("production is not an environment");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.code).toBe("validation/invalid_input");
      expect((error as PithyError).payload.action).toBe("Use `prod`.");
    }
  });

  test("refuses an over-long environment — every project-name budget is derived against this length", () => {
    const tooLong = "a".repeat(MAX_ENVIRONMENT_NAME + 1);
    expect(() => requireEnvironment(tooLong)).toThrow(new RegExp(`stops at ${MAX_ENVIRONMENT_NAME}`));
  });

  test("refuses `global` — it is the scope beside the environments, not one of them", () => {
    expect(() => requireEnvironment("global")).toThrow(/scope, not an environment/);
  });

  test("refuses a name no Cloudflare namespace would take", () => {
    for (const bad of ["Prod", "2prod", "-dev", "dev_1", ""]) expect(() => requireEnvironment(bad)).toThrow(PithyError);
  });
});

describe("requireManagedEnvironment", () => {
  test("accepts the deployed environments", () => {
    expect(requireManagedEnvironment("staging")).toBe("staging");
    expect(requireManagedEnvironment("prod")).toBe("prod");
  });

  test("refuses dev with the local answer, not a Zod stack trace", () => {
    try {
      requireManagedEnvironment("dev");
      expect.unreachable("dev is local-only");
    } catch (error) {
      expect(error).toBeInstanceOf(PithyError);
      expect((error as PithyError).payload.action).toContain("pithy dev");
    }
  });

  test("still refuses `production` at the naming rule, before the managed set is consulted", () => {
    expect(() => requireManagedEnvironment("production")).toThrow(/not an environment name/);
  });
});

describe("ENV_ARG", () => {
  test("names the three environments, so `--help` says what is legal without reading the source", () => {
    expect(ENV_ARG.description).toContain("dev");
    expect(ENV_ARG.description).toContain("staging");
    expect(ENV_ARG.description).toContain("prod");
  });
});

/**
 * The coverage gate. `--env` is a bare string on the wire, and the naming budgets every project name was
 * accepted under assume it is at most seven characters — so a command that reads `args.env` without
 * putting it through {@link requireEnvironment} composes Cloudflare names against a value nothing checked.
 * Grepping the command sources is crude, but it is the only check that fails when a *new* command forgets.
 */
describe("every command with an --env flag validates it", () => {
  test("no command reads args.env without requireEnvironment", async () => {
    const files = (await readdir(commandsDir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(join(commandsDir, file), "utf8");
      if (!source.includes("args.env")) continue;
      const checked = ["requireEnvironment(", "requireManagedEnvironment("].some((call) => source.includes(call));
      if (!checked) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
