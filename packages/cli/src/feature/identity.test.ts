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
import {
  branchIdentityWithoutWorkers,
  deriveIdentityFromBranch,
  parseFeatureBranch,
  projectCapabilitiesOrNull,
} from "./identity";
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

  test("**and a config that throws answers null rather than throwing or claiming none**", async () => {
    // Null is *unknowable from here*, and the caller has to tell it from "none". An empty array would let
    // destroy report a clean remote teardown having deleted nothing — the silent leak the guard exists for.
    //
    // Driven through the seams, because the discovery half has its own suite and this is about the catch.
    // The first version of this test pointed the real discoverer at a checkout it found no Workers in, so
    // it was answering "none" and asserting "unknowable" — passing for the opposite of its own reason.
    dir = await brokenWorkerCheckout();
    const answered = await projectCapabilitiesOrNull(dir, {
      discoverWorkers: async () => [{ name: "board", dir: join(dir ?? "", "apps", "board") } as never],
      loadConfig: async () => {
        throw new Error("this config will not load");
      },
    });
    expect(answered).toBeNull();
  });

  test("**a project with no Workers answers `[]`, not `null`** — review of #454", async () => {
    // `null` means *unknowable*, and destroy refuses on it with "this project's Worker configuration will
    // not load". For a project that simply has no Workers — an empty `apps/`, or one holding only
    // dev-only processes — that sentence is false and points at a file that does not exist, and a CI
    // teardown fails on it. Nothing was ever named, so there is nothing to recompute: the answer is none.
    dir = await brokenWorkerCheckout();
    expect(await projectCapabilitiesOrNull(dir, { discoverWorkers: async () => [] })).toEqual([]);
  });

  test("a checkout whose Workers do load still answers with them", async () => {
    // Without this the null above would pass against a function that had simply stopped working. Through
    // the same seams `resolveWorkers` already takes, because what is under test is the try/catch and not
    // worker discovery — which has its own suite next door.
    dir = await brokenWorkerCheckout();
    const answered = await projectCapabilitiesOrNull(dir, {
      discoverWorkers: async () => [{ name: "board", dir: join(dir ?? "", "apps", "board") } as never],
      loadConfig: async () => ({ capabilities: [] }) as never,
    });
    expect(answered).toEqual([]);
    // An empty *array* and a null are different answers, and the caller branches on exactly that.
    expect(answered).not.toBeNull();
  });
});
