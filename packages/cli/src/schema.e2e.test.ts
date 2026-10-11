// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import type { CliDescription, CommandTree } from "./contract/cliSchema";
import { buildDocsCatalog } from "./docs/catalog";
import { EXIT } from "./terminal/exitClass";
import { expectConforms } from "./test-utils/payloadContract";

/**
 * **`pithy schema`, from the real binary (#697).** The answer an agent gets is the one the installed CLI
 * gives, so this asks the binary rather than the module: the whole tree, one command, a refusal, and the
 * same document without `--json`.
 */

const run = promisify(execFile);
const bin = join(import.meta.dirname, "bin.ts");

/** A child environment that states its own format and input rules rather than inheriting the shell's. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", PITHY_NO_UPDATE_NOTIFIER: "1" };
  delete env.PITHY_JSON;
  delete env.PITHY_NONINTERACTIVE;
  delete env.FORCE_COLOR;
  return env;
}

async function pithy(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("bun", [bin, ...args], { env: cleanEnv(), maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("pithy schema, with the real binary", () => {
  test("--json describes every command the docs catalog lists, and conforms to its own payload", async () => {
    const { code, stdout } = await pithy(["schema", "--json"]);
    expect(code).toBe(0);
    await expectConforms("schema", stdout);
    const document = JSON.parse(stdout) as CliDescription;
    const catalog = await buildDocsCatalog();
    expect(document.commands.map((command) => command.path)).toEqual(catalog.commands.map((command) => command.path));
    expect(document.exitCodes.map((row) => row.exit)).toEqual([0, 1, 2, 3, 4, 5, 130, 141]);
    expect(document.environmentVariables.map((variable) => variable.name)).toContain("PITHY_NONINTERACTIVE");
  }, 60_000);

  test("a command of several words is that command and nothing else", async () => {
    const { code, stdout } = await pithy(["schema", "token", "mint", "--json"]);
    expect(code).toBe(0);
    const document = JSON.parse(stdout) as CommandTree;
    expect(document.path).toBe("token mint");
    expect(document.commands.map((command) => command.path)).toEqual(["token mint"]);
    expect(document.commands[0]?.flags.find((flag) => flag.name === "--permission")).toMatchObject({
      repeatable: true,
    });
  }, 60_000);

  test("a path the tree does not have is a usage error, on stderr, and stdout stays empty", async () => {
    const { code, stdout, stderr } = await pithy(["schema", "token", "mnt", "--json"]);
    expect(code).toBe(EXIT.usage);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toMatchObject({
      error: { code: "validation/invalid_input", message: "No command `pithy token mnt`.", exit: 2 },
    });
  }, 60_000);

  test("without --json the answer is the same document", async () => {
    const [plain, json] = await Promise.all([pithy(["schema", "provision"]), pithy(["schema", "provision", "--json"])]);
    expect(plain.code).toBe(0);
    expect(JSON.parse(plain.stdout)).toEqual(JSON.parse(json.stdout));
  }, 60_000);
});
