// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, describe, expect, test } from "vitest";
import { GIT_NO_MAINTENANCE, removeTempDir } from "../test-utils/tempRepo";
import { branchIdentityWithoutWorkers, deriveIdentityFromBranch, parseFeatureBranch } from "./identity";
import type { GitRunner } from "./worktree";

const run = promisify(execFile);

describe("parseFeatureBranch", () => {
  test("parses a valid feature branch", () => {
    expect(parseFeatureBranch("feature/69-media-cli")).toEqual({
      issue: "69",
      slug: "media-cli",
      branch: "feature/69-media-cli",
    });
  });

  test.each([
    ["main", "not a feature branch at all"],
    ["feature/nope", "no issue number"],
    ["feature/69-", "no slug"],
    ["feature/69-Bad_Slug", "slug is not kebab-case"],
  ])("returns null for %s (%s)", (branch) => {
    expect(parseFeatureBranch(branch)).toBeNull();
  });
});

describe("deriveIdentityFromBranch", () => {
  test("derives the identity from a feature branch", async () => {
    const git: GitRunner = async () => "feature/69-media-cli";
    const identity = await deriveIdentityFromBranch("/repo", git);
    expect(identity).toEqual({ issue: "69", slug: "media-cli", branch: "feature/69-media-cli" });
  });

  test("throws a PithyError when not on a feature branch", async () => {
    const git: GitRunner = async () => "main";
    await expect(deriveIdentityFromBranch("/repo", git)).rejects.toBeInstanceOf(PithyError);
  });
});

/**
 * A checkout on a feature branch whose **root** config is fine and whose **Worker** config throws.
 *
 * The state a `feature create` leaves when it fails partway, and the one `destroy` is most needed in.
 */
async function brokenWorkerCheckout(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-identity-"));
  await run("git", [...GIT_NO_MAINTENANCE, "init"], { cwd: dir });
  await run("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  await run("git", ["config", "user.name", "T"], { cwd: dir });
  await writeFile(join(dir, "pithy.config.ts"), `export default { name: "probe" };\n`);
  await mkdir(join(dir, "apps", "board"), { recursive: true });
  // Throws on load, exactly as a config too old for the current kit does.
  await writeFile(join(dir, "apps", "board", "pithy.config.ts"), `throw new Error("this config will not load");\n`);
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-m", "init"], { cwd: dir });
  await run("git", ["checkout", "-q", "-b", "feature/454-probe"], { cwd: dir });
  return dir;
}

describe("tearing down a feature whose Worker config will not load — #454", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await removeTempDir(dir);
    dir = null;
  });

  test("**the identity resolves without loading a single Worker config**", async () => {
    // Everything teardown's local half needs: the issue and slug from the branch, the project name from
    // the root config. Neither is a Worker's, which is why this answers where `branchIdentity` throws.
    dir = await brokenWorkerCheckout();
    expect(await branchIdentityWithoutWorkers(dir)).toEqual({ project: "probe", issue: "454", slug: "probe" });
  });
});
