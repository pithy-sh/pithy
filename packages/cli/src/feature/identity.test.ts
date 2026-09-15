// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, describe, expect, test } from "vitest";
import { isUnknown } from "../project/workerScope";
import { GIT_NO_MAINTENANCE, removeTempDir } from "../test-utils/tempRepo";
import {
  branchIdentity,
  branchIdentityWithoutWorkers,
  deriveIdentityFromBranch,
  featureCapabilitySet,
  parseFeatureBranch,
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
});

/**
 * **Teardown deletes by the capabilities provision named, composed for the same environment (#595).**
 *
 * `pithy provision --feature` composes for `feature`, so a capability a config enables for deployed
 * environments alone is provisioned — its resources created, its environment-scoped Secrets Store entries
 * minted. `pithy feature destroy` composed for no environment, never saw that capability, and exited 0 with
 * its resources and its live credentials still in the account.
 */
describe("a feature's teardown composes the set its provision named", () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await removeTempDir(dir);
    dir = null;
  });

  /** A checkout on a feature branch whose one Worker composes `vec` for every deployed environment. */
  async function deployedOnlyCheckout(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pithy-identity-env-"));
    await run("git", [...GIT_NO_MAINTENANCE, "init"], { cwd: root });
    await run("git", ["config", "user.email", "t@e.com"], { cwd: root });
    await run("git", ["config", "user.name", "T"], { cwd: root });
    await writeFile(join(root, "pithy.config.ts"), `export default { name: "acme" };\n`);
    await mkdir(join(root, "apps", "api"), { recursive: true });
    await writeFile(join(root, "apps", "api", "wrangler.jsonc"), `{ "name": "api" }\n`);
    await writeFile(
      join(root, "apps", "api", "pithy.config.ts"),
      [
        'const deployed = process.env.ENVIRONMENT !== undefined && process.env.ENVIRONMENT !== "dev";',
        "export default {",
        "  capabilities: [",
        '    { name: "app", requiredBindings: [] },',
        '    ...(deployed ? [{ name: "vec", requiredBindings: [{ name: "CACHE", type: "kv" }] }] : []),',
        "  ],",
        "};",
        "",
      ].join("\n"),
    );
    await run("git", ["add", "-A"], { cwd: root });
    await run("git", ["commit", "-m", "init"], { cwd: root });
    await run("git", ["checkout", "-q", "-b", "feature/12-thing"], { cwd: root });
    return root;
  }

  test("destroy's set is provision's set", async () => {
    dir = await deployedOnlyCheckout();
    // Teardown first: a config this process already evaluated is otherwise taken from the module cache,
    // and the order a real run meets them in is one process each.
    const destroyed = await featureCapabilitySet(dir);
    const { capabilities: provisioned } = await branchIdentity(dir);
    expect(isUnknown(destroyed) ? destroyed : destroyed.map((capability) => capability.name)).toEqual(["app", "vec"]);
    expect(provisioned.map((capability) => capability.name)).toEqual(["app", "vec"]);
  });
});
