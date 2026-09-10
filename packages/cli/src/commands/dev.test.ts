// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { stripAnsi } from "../dev/logging";
import dev, { collectAppFlags } from "./dev";

/** The args are a static object literal on this command — resolve their type for the assertions. */
type ArgSpec = { type: string; default?: unknown; description?: string };
const args = dev.args as Record<string, ArgSpec>;

describe("dev command", () => {
  test("is an agent-drivable command with a --json surface", () => {
    expect(dev.meta).toMatchObject({ name: "dev" });
    expect(Object.keys(args)).toEqual(["list", "app", "json"]);
    expect(args.list).toMatchObject({ type: "boolean", default: false });
    expect(args.app).toMatchObject({ type: "string" });
    expect(args.json).toMatchObject({ type: "boolean", default: false });
  });

  test("says --app is repeatable, because citty's own parse does not make it so", () => {
    expect(args.app?.description).toContain("repeatable");
  });
});

describe("collectAppFlags", () => {
  test("collects every occurrence, in the order they were given", () => {
    expect(collectAppFlags(["--app", "api", "--app", "web"])).toEqual(["api", "web"]);
  });

  test("accepts the equals spelling", () => {
    expect(collectAppFlags(["--app=api", "--app", "web"])).toEqual(["api", "web"]);
  });

  // A forgotten value used to collect nothing, and an empty selection starts the whole estate — the
  // exact opposite of what was asked. `--permission` fails open into a refusal; this fails open into
  // spawning every worker, so it has to refuse for itself.
  test("a trailing --app with nothing after it refuses", () => {
    expect(() => collectAppFlags(["--app"])).toThrow(ValidationError);
    expect(() => collectAppFlags(["--app"])).toThrow(/--app needs a worker name/);
  });

  test("a following flag is not a worker name", () => {
    expect(() => collectAppFlags(["--app", "--json"])).toThrow(ValidationError);
  });

  test("an empty --app= refuses too", () => {
    expect(() => collectAppFlags(["--app="])).toThrow(ValidationError);
  });

  test("no --app at all collects nothing", () => {
    expect(collectAppFlags(["--list", "--json"])).toEqual([]);
  });

  test("reads past the other flags", () => {
    expect(collectAppFlags(["--list", "--app", "api", "--json"])).toEqual(["api"]);
  });
});

describe("pithy dev --list", () => {
  let dir: string;
  let cwd: ReturnType<typeof vi.spyOn>;

  /** A one-Worker project with its ports already pinned — the settled case. */
  async function project(withConfig = true): Promise<void> {
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
    await writeFile(join(workerDir, "wrangler.jsonc"), `${JSON.stringify({ name: "acme-api" })}\n`);
    await writeFile(join(workerDir, "pithy.worker.jsonc"), "{}\n");
    if (!withConfig) return;
    await writeFile(
      join(dir, ".dev.config.json"),
      `${JSON.stringify({
        version: 1,
        branch: "main",
        ports: { index: 0, base: 8787, size: 20 },
        workers: { "acme-api": { port: 8787, origin: "http://localhost:8787" } },
      })}\n`,
    );
  }

  /** Run `pithy dev --list` from inside the project, capturing stdout. */
  async function run(json: boolean, rawArgs: string[] = []): Promise<string> {
    const written: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await dev.run?.({ args: { list: true, app: undefined, json }, rawArgs } as never);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    return written.join("");
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-dev-list-"));
    cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
  });

  afterEach(async () => {
    cwd.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  test("--json writes one object naming every member, its kind, and its pinned port", async () => {
    await project();

    const parsed = JSON.parse((await run(true)).trim()) as unknown;

    expect(parsed).toEqual({
      command: "dev",
      event: "list",
      members: [
        {
          name: "acme-api",
          kind: "app",
          autostart: true,
          starts: true,
          port: 8787,
          origin: "http://localhost:8787",
        },
      ],
    });
  });

  test("prints an aligned row per member, and no completion line — it reports, it does not act", async () => {
    await project();

    const plain = stripAnsi(await run(false));

    expect(plain).toContain("acme-api");
    expect(plain).toContain("app   starts   port 8787");
    expect(plain).not.toContain("Done");
  });

  test("a project that has never run pithy dev shows no port rather than inventing one", async () => {
    await project(false);

    const plain = stripAnsi(await run(false));

    expect(plain).toContain("port —");
    expect(plain).not.toMatch(/port \d/);
  });

  /**
   * The whole point of the flag. A `--list` that assigned a port, generated a `.dev.vars`, wrote a host
   * config or truncated `logs/dev.log` would have started the run it was asked to describe.
   */
  test("writes nothing at all", async () => {
    await project(false);
    const before = await readdir(dir);

    await run(false);

    expect(await readdir(dir)).toEqual(before);
    expect(await readdir(join(dir, "apps", "api"))).toEqual(["pithy.worker.jsonc", "wrangler.jsonc"]);
  });

  test("a project with no workers says so, and names the command that adds one", async () => {
    await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');

    expect(await run(false)).toContain("No workers. Run pithy worker add <name>, or pithy init.");
  });

  test("returns rather than exiting, so the process is the caller's again", async () => {
    await project();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await run(false);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  test("honors --app, listing every member and marking only what that selection would start", async () => {
    await project();
    const webDir = join(dir, "apps", "web");
    await mkdir(webDir, { recursive: true });
    await writeFile(join(webDir, "wrangler.jsonc"), `${JSON.stringify({ name: "acme-web" })}\n`);
    await writeFile(join(webDir, "pithy.worker.jsonc"), "{}\n");

    const parsed = JSON.parse((await run(true, ["--list", "--app", "web"])).trim()) as {
      members: { name: string; starts: boolean }[];
    };

    expect(parsed.members.map((m) => [m.name, m.starts])).toEqual([
      ["acme-api", false],
      ["acme-web", true],
    ]);
  });
});
