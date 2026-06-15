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

describe("pithy init", () => {
  test("scaffolds non-interactively and prints one JSON line", async () => {
    const target = join(dir, "smoke");
    const { stdout } = await run("bun", [bin, "init", "--name", "smoke", "--dir", target, "--json"]);

    const result = JSON.parse(stdout.trim()) as { command: string; appName: string; targetDir: string };
    expect(result).toEqual({ command: "init", appName: "smoke", targetDir: target });

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

    const { stdout } = await run("bun", [bin, "migrate", "--json"], { cwd: target });
    expect(JSON.parse(stdout.trim())).toEqual({ command: "migrate", env: "dev", rollback: false, databases: [] });

    const rollback = await run("bun", [bin, "migrate", "--rollback", "--json"], { cwd: target });
    expect(JSON.parse(rollback.stdout.trim())).toEqual({
      command: "migrate",
      env: "dev",
      rollback: true,
      databases: [],
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
