// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CATALOG } from "../capabilities/catalog";
import { walkTree } from "../contract/describe";
import { COMMAND_REGISTRY, main } from "../main";
import { ROOT_FLAG_DESCRIPTIONS } from "../rootFlags";
import { complete } from "./complete";

/**
 * **The real tree, completed (#765).** `complete.test.ts` proves the walk on a tree of its own; this proves
 * the binary's tree answers through it — every command, the flags, the values — and that a Tab loads only
 * the modules on the path it typed.
 *
 * Two command modules are replaced by factories that refuse to load. Neither is on any path typed below,
 * so a walk that imported a sibling to read it would reject here rather than pass slowly.
 */
const imported = vi.hoisted(() => [] as string[]);
vi.mock("../commands/deploy", () => {
  imported.push("deploy");
  throw new Error("pithy deploy was imported by a Tab that never typed it");
});
vi.mock("../commands/token", () => {
  imported.push("token");
  throw new Error("pithy token was imported by a Tab that never typed it");
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-complete-real-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** What a Tab at the end of `line` offers in `cwd`, values only. */
async function values(line: string, cwd = dir): Promise<string[]> {
  return (await complete(main, line, { cwd })).map((candidate) => candidate.value);
}

describe("the real tree", () => {
  test("pithy <Tab> offers every top-level command, and imports none of them", async () => {
    expect(await values("pithy ")).toEqual(Object.keys(COMMAND_REGISTRY));
    expect(imported).toEqual([]);
  });

  test("pithy secrets <Tab> offers every secrets subcommand, and imports only secrets", async () => {
    const nodes = (await import("../commands/secrets")).default;
    const subcommands = Object.keys(
      (typeof nodes.subCommands === "function" ? await nodes.subCommands() : await nodes.subCommands) ?? {},
    );
    expect(subcommands.length).toBeGreaterThan(0);
    expect(await values("pithy secrets ")).toEqual(subcommands);
    expect(imported).toEqual([]);
  });

  test("pithy dev --<Tab> offers dev's own flags and the flags every command takes", async () => {
    const offered = await values("pithy dev --");
    for (const flag of ["--app", "--list", "--tui", ...ROOT_FLAG_DESCRIPTIONS.map((root) => root.name)]) {
      expect(offered).toContain(flag);
    }
  });

  test("--env <Tab> offers the environments", async () => {
    expect(await values("pithy migrate --env ")).toEqual([...ENVIRONMENTS]);
  });

  test("--worker <Tab> offers the project's Workers, and nothing outside a project", async () => {
    expect(await values("pithy migrate --worker ")).toEqual([]);
    await writeFile(join(dir, "pithy.config.ts"), "export default {};\n");
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(join(dir, "apps", "api", "wrangler.jsonc"), "{}");
    expect(await values("pithy migrate --worker ")).toEqual(["api"]);
    expect(await values("pithy dev --app ")).toEqual(["api"]);
  });

  test("pithy add <Tab> and pithy remove <Tab> offer the capabilities", async () => {
    const names = CATALOG.map((entry) => entry.name);
    expect(await values("pithy add ")).toEqual(names);
    expect(await values("pithy remove ")).toEqual(names);
  });

  test("pithy feature destroy --branch <Tab> completes outside a repository with nothing, and no error", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "export default {};\n");
    expect(await values("pithy feature destroy --branch ")).toEqual([]);
  });

  test("every command in the tree completes from its parent, so a new one needs nothing here", async () => {
    // Walked from each top-level command but the two that refuse to load, which are covered by the first case.
    const nodes = [];
    for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
      if (name === "deploy" || name === "token") continue;
      nodes.push({ path: [name] }, ...(await walkTree(await entry.load(), [name])));
    }
    expect(nodes.length).toBeGreaterThan(50);
    for (const node of nodes) {
      const parent = node.path.slice(0, -1);
      const name = node.path.at(-1) as string;
      const line = `pithy ${[...parent, name.slice(0, 1)].join(" ")}`;
      expect(await values(line), line).toContain(name);
    }
  });

  test("outside a Pithy project, project values complete nothing and nothing throws", async () => {
    expect(await values("pithy add --worker ")).toEqual([]);
    expect(await values("pithy feature destroy --branch ")).toEqual([]);
    expect(await values("pithy nonsense --")).toEqual([]);
  });
});
