// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { memberName, memberPath, pnpmWorkspacePatterns, workspaceMembers } from "./workspaceMembers";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-members-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function manifest(rel: string, doc: unknown = {}): Promise<void> {
  await mkdir(join(dir, rel), { recursive: true });
  await writeFile(join(dir, rel, "package.json"), JSON.stringify(doc));
}

describe("workspaceMembers", () => {
  test("no workspaces field reads the root and every apps/* directory", async () => {
    await manifest(".", { name: "root" });
    await manifest("apps/web");
    await mkdir(join(dir, "apps", "empty"), { recursive: true });
    await manifest("packages/shared");
    expect(await workspaceMembers(dir)).toEqual([".", "apps/empty", "apps/web"]);
  });

  test("no root manifest still reads apps/*", async () => {
    await manifest("apps/api");
    expect(await workspaceMembers(dir)).toEqual([".", "apps/api"]);
  });

  test("the array form adds every matched directory that holds a package.json", async () => {
    await manifest(".", { workspaces: ["apps/*", "packages/*"] });
    await manifest("apps/api");
    await manifest("packages/shared");
    await mkdir(join(dir, "packages", "notes"), { recursive: true });
    expect(await workspaceMembers(dir)).toEqual([".", "apps/api", "packages/shared"]);
  });

  test("the { packages } form reads the same way", async () => {
    await manifest(".", { workspaces: { packages: ["./libs/*/"], nohoist: ["**"] } });
    await manifest("libs/db");
    expect(await workspaceMembers(dir)).toEqual([".", "libs/db"]);
  });

  test("pnpm-workspace.yaml is read beside the root manifest", async () => {
    await manifest(".");
    await writeFile(join(dir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n  - \"tools/cli\"\n");
    await manifest("packages/shared");
    await manifest("tools/cli");
    expect(await workspaceMembers(dir)).toEqual([".", "packages/shared", "tools/cli"]);
  });

  test("negated globs remove what an earlier glob matched", async () => {
    await manifest(".", { workspaces: ["packages/*", "!packages/legacy"] });
    await manifest("packages/shared");
    await manifest("packages/legacy");
    expect(await workspaceMembers(dir)).toEqual([".", "packages/shared"]);
  });

  test("** descends any depth and never into node_modules or a dot directory", async () => {
    await manifest(".", { workspaces: ["packages/**"] });
    await manifest("packages/a");
    await manifest("packages/group/b");
    await manifest("packages/a/node_modules/dep");
    await manifest("packages/.cache/c");
    await manifest("packages/node_modules/x");
    expect(await workspaceMembers(dir)).toEqual([".", "packages/a", "packages/group/b"]);
  });

  test("a glob that names node_modules literally matches nothing", async () => {
    await manifest(".", { workspaces: ["node_modules/*"] });
    await manifest("node_modules/dep");
    expect(await workspaceMembers(dir)).toEqual(["."]);
  });

  test("a member listed by two globs is read once", async () => {
    await manifest(".", { workspaces: ["packages/*", "packages/shared", "apps/*"] });
    await writeFile(join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await manifest("packages/shared");
    await manifest("apps/api");
    expect(await workspaceMembers(dir)).toEqual([".", "apps/api", "packages/shared"]);
  });

  test("a glob that leaves the project is ignored", async () => {
    await manifest(".", { workspaces: ["../*", join(tmpdir(), "*")] });
    expect(await workspaceMembers(dir)).toEqual(["."]);
  });

  test("a root manifest that will not parse reads as no workspaces", async () => {
    await mkdir(join(dir, "apps", "api"), { recursive: true });
    await writeFile(join(dir, "package.json"), "{ nope");
    expect(await workspaceMembers(dir)).toEqual([".", "apps/api"]);
  });
});

describe("pnpmWorkspacePatterns", () => {
  test("the block list, quoted or bare, comments dropped", () => {
    const text = [
      "# the workspace",
      "packages:",
      "  # Workers",
      "  - 'apps/*'",
      '  - "packages/*" # libraries',
      "  - '!**/test/**'",
      "catalog:",
      "  - not-a-package",
    ].join("\n");
    expect(pnpmWorkspacePatterns(text)).toEqual(["apps/*", "packages/*", "!**/test/**"]);
  });

  test("the block list at column 0, under the key", () => {
    const text = ["packages:", "- 'apps/*'", "# libraries", "- packages/*", "catalog:", "  react: ^19"].join("\n");
    expect(pnpmWorkspacePatterns(text)).toEqual(["apps/*", "packages/*"]);
  });

  test("the flow list", () => {
    expect(pnpmWorkspacePatterns("packages: ['apps/*', \"libs/*\"]\n")).toEqual(["apps/*", "libs/*"]);
  });

  test("no packages key reads as none", () => {
    expect(pnpmWorkspacePatterns("onlyBuiltDependencies:\n  - esbuild\n")).toEqual([]);
  });
});

describe("memberName", () => {
  test("an apps/* member is named by its directory, anything else by its path", () => {
    expect(memberName("apps/board")).toBe("board");
    expect(memberName("packages/shared")).toBe("packages/shared");
    expect(memberName("apps/group/inner")).toBe("apps/group/inner");
  });

  test("a member directly under the root is named ./<dir>, so it never reads as an apps/* Worker's name", () => {
    expect(memberName("mobile")).toBe("./mobile");
    expect(memberName("board")).not.toBe(memberName("apps/board"));
  });
});

describe("memberPath", () => {
  test("turns a member's name back into its path", () => {
    expect(memberPath("board")).toBe("apps/board");
    expect(memberPath("packages/shared")).toBe("packages/shared");
    expect(memberPath(memberName("apps/group/inner"))).toBe("apps/group/inner");
  });

  test("round-trips every shape of member, one directly under the root included", () => {
    for (const member of ["apps/board", "packages/shared", "apps/group/inner", "mobile", "apps"]) {
      expect(memberPath(memberName(member))).toBe(member);
    }
  });
});
