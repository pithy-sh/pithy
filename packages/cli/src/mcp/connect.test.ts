// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { clientById, type McpClient } from "./clients";
import { configDirOf, connect, isInstalled, type McpOptions, targetFor } from "./connect";

let dir: string;
let project: string;
let outside: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-mcp-link-"));
  project = join(dir, "repo");
  outside = join(dir, "outside");
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a project path that leaves the project", () => {
  test("a symlinked config directory is refused, and nothing is written through it", async () => {
    // What a cloned repository can ship: `.zed` is a link, so `.zed/settings.json` resolves outside.
    await symlink(outside, join(project, ".zed"));
    const client = clientById("zed") as McpClient;
    const result = await connect(targetFor(client, "project", { projectDir: project }));
    expect(result.state).toBe("refused");
    expect(result.reason).toContain("symlink");
    expect(existsSync(join(outside, "settings.json"))).toBe(false);
  });

  test("a symlinked config file is refused too, dangling or not", async () => {
    await mkdir(join(project, ".cursor"), { recursive: true });
    await symlink(join(outside, "planted.json"), join(project, ".cursor", "mcp.json"));
    const client = clientById("cursor") as McpClient;
    const result = await connect(targetFor(client, "project", { projectDir: project }));
    expect(result.state).toBe("refused");
    expect(existsSync(join(outside, "planted.json"))).toBe(false);
  });

  test("an ordinary project path is still written", async () => {
    const client = clientById("cursor") as McpClient;
    const result = await connect(targetFor(client, "project", { projectDir: project }));
    expect(result.state).toBe("added");
    expect(existsSync(join(project, ".cursor", "mcp.json"))).toBe(true);
  });

  test("an ordinary project file that already exists is not mistaken for an escape", async () => {
    // The containment gate walks to the file, and `ensureScaffoldPath` refuses a non-directory anywhere
    // on that walk — so handing it the file itself refused every project already connected, on the
    // second run, with "isn't a directory". The gate takes the directory; the file gets its own check.
    const client = clientById("cursor") as McpClient;
    const target = targetFor(client, "project", { projectDir: project });
    expect((await connect(target)).state).toBe("added");
    const second = await connect(target);
    expect(second.state).toBe("unchanged");
    expect(second.reason).toBeNull();
  });

  test("the root is what refuses it — a target carrying none writes straight through", () => {
    // The anti-vacuity half. Without this, the three tests above would still pass if `connect` simply
    // never wrote anything, and the gate they exist for could be deleted unnoticed. A target built by
    // hand with no root takes the path `targetFor` never produces for a project file, and it writes
    // through the link — which is exactly the behavior `root` exists to prevent.
    return (async () => {
      await symlink(outside, join(project, ".zed"));
      const client = clientById("zed") as McpClient;
      const ungated = { client, scope: "project" as const, path: join(project, ".zed", "settings.json"), root: null };
      const result = await connect(ungated);
      expect(result.state).toBe("added");
      expect(existsSync(join(outside, "settings.json"))).toBe(true);
    })();
  });
});

describe("a client whose user configuration a variable moves (#900)", () => {
  /** A throwaway machine: `dir/home` is the home, and `env` is the whole environment — never the operator's. */
  function machine(env: NodeJS.ProcessEnv, configDir?: string): McpOptions {
    return { projectDir: project, home: { platform: "linux", env, homedir: join(dir, "home") }, configDir };
  }

  const claude = () => clientById("claude-code") as McpClient;
  const codex = () => clientById("codex") as McpClient;

  test("CLAUDE_CONFIG_DIR moves Claude Code's user file to `.claude.json` under it", () => {
    const profile = join(dir, "profile");
    expect(targetFor(claude(), "user", machine({ CLAUDE_CONFIG_DIR: profile })).path).toBe(
      join(profile, ".claude.json"),
    );
  });

  test("CODEX_HOME moves Codex's user file to `config.toml` under it", () => {
    const profile = join(dir, "codex-work");
    expect(targetFor(codex(), "user", machine({ CODEX_HOME: profile })).path).toBe(join(profile, "config.toml"));
  });

  test("an unset or empty variable resolves exactly as before", () => {
    const home = join(dir, "home");
    for (const env of [{}, { CLAUDE_CONFIG_DIR: "" }, { CLAUDE_CONFIG_DIR: "  " }]) {
      expect(targetFor(claude(), "user", machine(env)).path).toBe(join(home, ".claude.json"));
    }
    expect(targetFor(codex(), "user", machine({ CODEX_HOME: "" })).path).toBe(join(home, ".codex", "config.toml"));
  });

  test("`--config-dir` wins over the variable", () => {
    const named = join(dir, "named");
    const options = machine({ CLAUDE_CONFIG_DIR: join(dir, "exported") }, named);
    expect(configDirOf(claude(), options)).toBe(named);
    expect(targetFor(claude(), "user", options).path).toBe(join(named, ".claude.json"));
  });

  test("the project scope is never moved", () => {
    const options = machine({ CLAUDE_CONFIG_DIR: join(dir, "profile") }, join(dir, "named"));
    expect(targetFor(claude(), "project", options).path).toBe(join(project, ".mcp.json"));
  });

  test("a row that declares no variable is not moved by anybody's", () => {
    const cursor = clientById("cursor") as McpClient;
    const options = machine({ CLAUDE_CONFIG_DIR: join(dir, "profile"), CODEX_HOME: join(dir, "codex") });
    expect(configDirOf(cursor, options)).toBeUndefined();
    expect(targetFor(cursor, "user", options).path).toBe(join(dir, "home", ".cursor", "mcp.json"));
  });

  test("detection follows the variable: the moved directory is what says the tool is here", async () => {
    const profile = join(dir, "codex-work");
    await mkdir(profile, { recursive: true });
    expect(await isInstalled(codex(), machine({ CODEX_HOME: profile }))).toBe(true);
    // And the fixed path no longer answers for it. `~/.codex` exists, but the profile in use is elsewhere.
    await mkdir(join(dir, "home", ".codex"), { recursive: true });
    expect(await isInstalled(codex(), machine({ CODEX_HOME: join(dir, "nowhere") }))).toBe(false);
  });

  test("a `~/.claude.json` is not Claude Code being here when CLAUDE_CONFIG_DIR points elsewhere", async () => {
    await mkdir(join(dir, "home"), { recursive: true });
    await writeFile(join(dir, "home", ".claude.json"), "{}\n");
    expect(await isInstalled(claude(), machine({}))).toBe(true);
    expect(await isInstalled(claude(), machine({ CLAUDE_CONFIG_DIR: join(dir, "nowhere") }))).toBe(false);
  });

  test("a user write lands in the moved file", async () => {
    const profile = join(dir, "profile");
    const result = await connect(targetFor(claude(), "user", machine({ CLAUDE_CONFIG_DIR: profile })));
    expect(result.state).toBe("added");
    expect(existsSync(join(profile, ".claude.json"))).toBe(true);
    expect(existsSync(join(dir, "home", ".claude.json"))).toBe(false);
  });
});
