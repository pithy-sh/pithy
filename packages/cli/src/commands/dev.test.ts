// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { stripAnsi } from "../dev/logging";
import dev, { autostartIntent, collectAppFlags } from "./dev";

/** The args are a static object literal on this command — resolve their type for the assertions. */
type ArgSpec = { type: string; default?: unknown; description?: string };
const args = dev.args as Record<string, ArgSpec>;

describe("dev command", () => {
  test("is an agent-drivable command with a --json surface", () => {
    expect(dev.meta).toMatchObject({ name: "dev" });
    expect(Object.keys(args)).toEqual(["list", "app", "disable-autostart", "enable-autostart", "tui", "json"]);
    expect(args.list).toMatchObject({ type: "boolean", default: false });
    expect(args.app).toMatchObject({ type: "string" });
    expect(args.json).toMatchObject({ type: "boolean", default: false });
  });

  test("says --app is repeatable, because citty's own parse does not make it so", () => {
    expect(args.app?.description).toContain("repeatable");
  });
});

/**
 * **The two flags that write instead of running (#548).**
 *
 * They put a line in a file the person never opens, so neither refusal here is pedantry. Both flags at
 * once has no safe reading — preferring either silently writes the opposite of what half the people who
 * typed it expected. And the permissive reading of a bare `--disable-autostart`, *every worker*, is the
 * one answer nobody means: it would park the whole dev set on a flag somebody typed by itself.
 */
describe("autostartIntent", () => {
  test("--disable-autostart with --app means disable", () => {
    expect(autostartIntent({ disable: true, enable: false, apps: ["payments"] })).toEqual({ enabled: false });
  });

  test("--enable-autostart with --app means enable", () => {
    expect(autostartIntent({ disable: false, enable: true, apps: ["payments"] })).toEqual({ enabled: true });
  });

  test("both at once is refused rather than resolved", () => {
    expect(() => autostartIntent({ disable: true, enable: true, apps: ["payments"] })).toThrow(ValidationError);
  });

  // The action line has to name the flag they actually typed, or it reads as advice about the other one.
  test("neither, without --app, is refused and the remedy names the flag that was typed", () => {
    const disabling = (() => {
      try {
        autostartIntent({ disable: true, enable: false, apps: [] });
      } catch (error) {
        return error as ValidationError;
      }
      throw new Error("expected a refusal");
    })();
    expect(disabling.payload.action).toContain("--disable-autostart");

    const enabling = (() => {
      try {
        autostartIntent({ disable: false, enable: true, apps: [] });
      } catch (error) {
        return error as ValidationError;
      }
      throw new Error("expected a refusal");
    })();
    expect(enabling.payload.action).toContain("--enable-autostart");
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

  /** Run `pithy dev` from inside the project with the given args, capturing stdout. */
  async function invoke(args: Record<string, unknown>, rawArgs: string[] = []): Promise<string> {
    const written: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await dev.run?.({
        args: {
          list: false,
          app: undefined,
          "disable-autostart": false,
          "enable-autostart": false,
          json: false,
          ...args,
        },
        rawArgs,
      } as never);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
    return written.join("");
  }

  /** Run `pithy dev --list` from inside the project, capturing stdout. */
  async function run(json: boolean, rawArgs: string[] = []): Promise<string> {
    return invoke({ list: true, json }, rawArgs);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-dev-list-"));
    cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
  });

  afterEach(async () => {
    cwd.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * **`--list` describes the run this command would make, so it reads the answer the run reads.**
   *
   * It did not, for one commit. `startDev` resolved this branch's `dev-ports.json` answer and
   * `printDevSet` called `listDevSet` without it, so a worker somebody had turned off still listed as
   * starting. Every unit test passed: each injected `autostartOverrides` straight into `listDevSet`, and
   * none of them went through the command, which is the only place the two paths could disagree.
   *
   * So this one drives the real `dev.run` twice — once to write, once to read — through a redirected
   * config directory. Nothing is stubbed between the flag and the file.
   */
  test("a worker turned off through the flag is what --list then reports", async () => {
    await project();
    const configDir = await mkdtemp(join(tmpdir(), "pithy-dev-cfg-"));
    const previous = process.env.PITHY_CONFIG_DIR;
    process.env.PITHY_CONFIG_DIR = configDir;
    try {
      await invoke({ "disable-autostart": true }, ["--app", "acme-api", "--disable-autostart"]);

      const listed = stripAnsi(await run(false));
      expect(listed).toContain("skipped");
      expect(listed).toContain("off here");

      // And back again — `--enable-autostart` is the undo, not a second kind of write.
      await invoke({ "enable-autostart": true }, ["--app", "acme-api", "--enable-autostart"]);
      const after = stripAnsi(await run(false));
      expect(after).toContain("starts");
      expect(after).not.toContain("off here");
    } finally {
      if (previous === undefined) delete process.env.PITHY_CONFIG_DIR;
      else process.env.PITHY_CONFIG_DIR = previous;
      await rm(configDir, { recursive: true, force: true });
    }
  });

  test("--json writes one object naming every member, its kind, and its pinned port", async () => {
    await project();

    const parsed = JSON.parse((await run(true)).trim()) as unknown;

    expect(parsed).toEqual({
      command: "dev",
      event: "list",
      // Present and empty on a machine with nothing stale (#685) — a consumer reads a field, never the
      // absence of one.
      staleAutostart: [],
      members: [
        {
          name: "acme-api",
          kind: "app",
          autostart: true,
          autostartLocal: false,
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
    expect(plain).toContain("app     starts   port 8787");
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

  /**
   * **`--list` names a checkout that is gone, through the same function the run names it with (#685).**
   *
   * The same divergence this suite already records for `autostartOverrides`, one field across: `startDev`
   * says it and `printDevSet` is a separate code path, so a report added only to the run would leave
   * `pithy dev --list` silent and `--list --json` with no field — and nothing would have failed.
   */
  describe("a checkout that is gone", () => {
    let configDir: string;
    let previous: string | undefined;

    /** Capture both streams: the prose is the operator's, stdout is the machine's. */
    async function listBoth(json: boolean): Promise<{ out: string; err: string }> {
      const out: string[] = [];
      const err: string[] = [];
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        out.push(String(chunk));
        return true;
      });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        err.push(String(chunk));
        return true;
      });
      try {
        await dev.run?.({
          args: { list: true, app: undefined, "disable-autostart": false, "enable-autostart": false, json },
          rawArgs: [],
        } as never);
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }
      return { out: out.join(""), err: err.join("") };
    }

    beforeEach(async () => {
      configDir = await mkdtemp(join(tmpdir(), "pithy-dev-list-cfg-"));
      previous = process.env.PITHY_CONFIG_DIR;
      process.env.PITHY_CONFIG_DIR = configDir;
      await writeFile(
        join(configDir, "dev-ports.json"),
        `${JSON.stringify({
          "/gone/app": { main: { block: 0, base: 8787, size: 20, autostart: { "acme-api": false } } },
        })}\n`,
      );
    });

    afterEach(async () => {
      if (previous === undefined) delete process.env.PITHY_CONFIG_DIR;
      else process.env.PITHY_CONFIG_DIR = previous;
      await rm(configDir, { recursive: true, force: true });
    });

    test("prints the sentence to stderr and lists the set unchanged", async () => {
      await project();

      const { out, err } = await listBoth(false);

      expect(err).toContain("Autostart answers are recorded for a checkout at /gone/app, which is gone: acme-api.");
      // The row is what it always was: the orphaned answer is under another key, so it narrows nothing.
      expect(stripAnsi(out)).toContain("app     starts   port 8787");
    });

    test("--json carries the stale roots beside the members", async () => {
      await project();

      const parsed = JSON.parse((await listBoth(true)).out.trim()) as { staleAutostart: { root: string }[] };

      expect(parsed.staleAutostart).toEqual([
        { root: "/gone/app", branches: [{ branch: "main", workers: ["acme-api"] }] },
      ]);
    });
  });
});
