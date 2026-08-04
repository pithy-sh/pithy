// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const run = promisify(execFile);
const bin = join(import.meta.dirname, "bin.ts");

/**
 * End-to-end: the real bin, spawned the way an agent drives it (spec §10.20) —
 * full flags, no prompts, `--json`. Projects scaffold inside the package (not
 * the OS tmpdir) so their imports resolve against the workspace node_modules.
 */
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(import.meta.dirname, "..", ".smoke-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A child environment with every color signal scrubbed, so the child decides color on its own terms.
 * Vitest sets `TEST` and CI sets `CI` — citty reads both as "no color", which would make a piped-output
 * assertion pass for a reason that has nothing to do with the code under test. `TERM` is set to an
 * ordinary color terminal for the same reason: citty treats `dumb` as no color.
 */
function colorCapableEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TERM: "xterm-256color", PITHY_NO_UPDATE_NOTIFIER: "1" };
  for (const key of ["NO_COLOR", "FORCE_COLOR", "TEST", "CI"]) delete env[key];
  return env;
}

/** The escape byte every ANSI sequence opens with. */
const ESC = "\u001b";

describe("root flags", () => {
  /**
   * `execFile` pipes stdout, so `process.stdout.isTTY` is false in the child and Pithy's one color
   * authority (`terminal/style`) says color is off. citty renders help itself and consults none of that —
   * it reads only `NO_COLOR === "1"`, `TERM=dumb`, `TEST` and `CI` — so without the bin handing it that
   * one lever, `pithy --help | cat` writes escape codes into a pipe while every other surface goes plain.
   */
  test("help into a pipe carries no ANSI, like every other surface", async () => {
    for (const args of [["--help"], ["add", "--help"]]) {
      const { stdout } = await run("bun", [bin, ...args], { env: colorCapableEnv() });
      expect(stdout).toContain("USAGE");
      expect(stdout).not.toContain(ESC);
    }
  });

  /** The reverse direction is deliberate: `FORCE_COLOR` is Pithy's override, so citty must honor it too. */
  test("FORCE_COLOR still colors help", async () => {
    const { stdout } = await run("bun", [bin, "--help"], { env: { ...colorCapableEnv(), FORCE_COLOR: "1" } });
    expect(stdout).toContain(ESC);
  });

  /**
   * citty answers its version builtin only when it is the sole argument, so `pithy add --version` used to
   * run `add` and fail asking for a capability. docs/CLI.md §1.2 promises the flag works on any command.
   */
  test("--version and -v print the bare version on any command", async () => {
    const { version } = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
      version: string;
    };
    for (const args of [["--version"], ["-v"], ["add", "--version"], ["add", "-v"], ["token", "create", "-v"]]) {
      const { stdout, stderr } = await run("bun", [bin, ...args], { cwd: dir, env: colorCapableEnv() });
      expect(stdout.trim()).toBe(version);
      expect(stderr).toBe("");
    }
  });

  /** Everything after `--` is payload for a child process, never a Pithy flag. */
  test("a `--version` after `--` is not the version flag", async () => {
    const error = (await run("bun", [bin, "add", "--", "--version"], { cwd: dir, env: colorCapableEnv() }).catch(
      (e: unknown) => e,
    )) as { code: number; stdout: string };
    // citty reads it as `add`'s capability argument, and `add` runs — the point is that the bin did not
    // intercept it. Outside a project that run fails, which is `add`'s business, not the flag's.
    expect(error.code).toBe(1);
    expect(error.stdout).toBe("");
  });
});

describe("pithy init", () => {
  test("scaffolds non-interactively and prints one JSON line", async () => {
    const target = join(dir, "smoke");
    const { stdout } = await run("bun", [bin, "init", "--name", "smoke", "--dir", target, "--json"]);

    const result = JSON.parse(stdout.trim()) as { command: string; appName: string; targetDir: string };
    // `worker` names the first worker created at apps/<name>; a non-interactive run takes the default.
    // `domains` is null because a non-interactive run asks nothing — every command must work headless,
    // and a required prompt would break that. A project declares `domains` in pithy.config.ts directly.
    expect(result).toEqual({ command: "init", appName: "smoke", targetDir: target, worker: "api", domains: null });

    const pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as { name: string };
    expect(pkg.name).toBe("smoke");
  });

  test("a non-empty target fails with problem and action lines, exit 1", async () => {
    await writeFile(join(dir, "keep.txt"), "mine");
    const error = (await run("bun", [bin, "init", "--name", "x", "--dir", dir]).catch((e: unknown) => e)) as {
      code: number;
      stderr: string;
    };
    expect(error.code).toBe(1);
    const [problem, action] = error.stderr.trim().split("\n");
    expect(problem).toContain("isn't empty.");
    expect(action).toContain("Run pithy init again.");
  });

  test("--json renders the error as a parseable envelope on stderr, exit 1", async () => {
    await writeFile(join(dir, "keep.txt"), "mine");
    const error = (await run("bun", [bin, "init", "--name", "x", "--dir", dir, "--json"]).catch((e: unknown) => e)) as {
      code: number;
      stdout: string;
      stderr: string;
    };
    expect(error.code).toBe(1);
    expect(error.stdout).toBe(""); // stdout stays clean — the result channel
    expect(JSON.parse(error.stderr.trim())).toEqual({
      error: {
        code: "core/conflict",
        status: 409,
        message: expect.stringContaining("isn't empty."),
        action: expect.stringContaining("Run pithy init again."),
      },
    });
  });
});

describe("pithy add", () => {
  // The full `add <cap>` flow installs from the registry — not exercised here
  // (the project never hits the network in tests; see e2e.test.ts). These cover
  // the install-free surfaces: discovery and argument validation.
  test("--list shows the built-in catalog, exit 0", async () => {
    const { stdout } = await run("bun", [bin, "add", "--list"], { cwd: dir });
    expect(stdout).toContain("auth");
    expect(stdout).toContain("storage");
    expect(stdout).not.toContain("(installed)"); // nothing installed in an empty dir
  });

  test("--list --json emits the catalog with installed flags, exit 0", async () => {
    const { stdout } = await run("bun", [bin, "add", "--list", "--json"], { cwd: dir });
    const result = JSON.parse(stdout.trim()) as {
      command: string;
      capabilities: { name: string; installed: boolean }[];
    };
    expect(result.command).toBe("add");
    expect(result.capabilities.map((c) => c.name)).toContain("auth");
    expect(result.capabilities.every((c) => c.installed === false)).toBe(true);
  });

  test("no capability and no --list points at --list, exit 1", async () => {
    const error = (await run("bun", [bin, "add"], { cwd: dir }).catch((e: unknown) => e)) as {
      code: number;
      stderr: string;
    };
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("Name a capability");
    expect(error.stderr).toContain("pithy add --list");
  });
});

describe("pithy migrate", () => {
  test("runs the empty registry in a fresh scaffold and reports per-database results", async () => {
    const target = join(dir, "app");
    await run("bun", [bin, "init", "--name", "app", "--dir", target, "--json"]);

    // The run is grouped per worker — the scaffold's single `apps/api` worker, with no databases yet.
    const { stdout } = await run("bun", [bin, "migrate", "--json"], { cwd: target });
    expect(JSON.parse(stdout.trim())).toEqual({
      command: "migrate",
      env: "dev",
      project: "app",
      rollback: false,
      workers: [{ worker: "app-api", databases: [] }],
    });

    const rollback = await run("bun", [bin, "migrate", "--rollback", "--json"], { cwd: target });
    expect(JSON.parse(rollback.stdout.trim())).toEqual({
      command: "migrate",
      env: "dev",
      project: "app",
      rollback: true,
      workers: [{ worker: "app-api", databases: [] }],
    });
  });

  test("outside a project it says what to do", async () => {
    const error = (await run("bun", [bin, "migrate"], { cwd: dir }).catch((e: unknown) => e)) as {
      code: number;
      stderr: string;
    };
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("No pithy.config.ts here.");
    expect(error.stderr).toContain("pithy init creates one.");
  });

  test("human output ends with Done.", async () => {
    const target = join(dir, "voice");
    await run("bun", [bin, "init", "--name", "voice", "--dir", target, "--json"]);
    const { stdout } = await run("bun", [bin, "migrate"], { cwd: target });
    expect(stdout.trim().endsWith("Done.")).toBe(true);
  });
});
