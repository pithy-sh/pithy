// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { clientById, type McpClient } from "./clients";
import { connect, targetFor } from "./connect";

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
