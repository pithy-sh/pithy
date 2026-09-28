// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PithyError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, describe, expect, test } from "vitest";
import { isUnknown } from "../project/workerScope";
import { GIT_NO_MAINTENANCE, removeTempDir } from "../test-utils/tempRepo";
import {
  branchIdentity,
  branchIdentityWithoutWorkers,
  deriveIdentityFromBranch,
  featureCapabilitySet,
  parseFeatureBranch,
  requireFeatureBranch,
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
    ["feature/1234567890-x", "more digits than a feature name reserves"],
  ])("returns null for %s (%s)", (branch) => {
    expect(parseFeatureBranch(branch)).toBeNull();
  });

  /**
   * **`feature/012-x` is feature 12 — #660.**
   *
   * `canonicalIssue` has settled this for resource names since #643: `f012` and `f12` would otherwise be
   * two features sharing one set of rate-limit namespaces. The branch did not go through it, so the
   * remote half of a teardown addressed feature 12 while its local half looked for a `feature/012-x`
   * registry key and a `.worktrees/012-x` directory. One parser, so now one string.
   */
  test("the issue is canonical, and so is the branch it reports", () => {
    expect(parseFeatureBranch("feature/012-x")).toEqual({
      issue: "12",
      slug: "x",
      branch: "feature/12-x",
    });
    expect(parseFeatureBranch("feature/012-x")).toEqual(parseFeatureBranch("feature/12-x"));
  });

  /** `0` is an issue number, and stripping it to nothing would be the obvious way to get this wrong. */
  test("issue 0 survives canonicalisation", () => {
    expect(parseFeatureBranch("feature/0-x")?.issue).toBe("0");
    expect(parseFeatureBranch("feature/00-x")?.branch).toBe("feature/0-x");
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

/**
 * **A feature can be named instead of inferred — #660.**
 *
 * `pithy feature destroy` read the checkout's own branch, which is the one thing a merged pull request's
 * runner does not have: the branch is deleted and `refs/pull/<n>/head` checks out detached, so
 * `--abbrev-ref HEAD` answers `HEAD`. The pipeline holds `github.event.pull_request.head.ref` — the event
 * payload is a snapshot and outlives the branch — and the CLI would not be told it.
 *
 * The flag joins the existing parser rather than bringing its own, so the two paths cannot come to
 * disagree about what a feature is called.
 */
describe("naming the feature rather than inferring it — #660", () => {
  /** The `PithyError` a call threw, or a failure here — never a silent pass over a call that returned. */
  function refusalFor(call: () => unknown): PithyError {
    try {
      call();
    } catch (error) {
      if (error instanceof PithyError) return error;
      throw error;
    }
    throw new Error("expected a refusal, got a value");
  }

  let dir: string | null = null;

  afterEach(async () => {
    if (dir) await removeTempDir(dir);
    dir = null;
  });

  /** A checkout of a project called `probe` with **no branch at all** — the runner's state, exactly. */
  async function detachedCheckout(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pithy-identity-detached-"));
    await run("git", [...GIT_NO_MAINTENANCE, "init"], { cwd: root });
    await run("git", ["config", "user.email", "t@e.com"], { cwd: root });
    await run("git", ["config", "user.name", "T"], { cwd: root });
    await writeFile(join(root, "pithy.config.ts"), `export default { name: "probe" };\n`);
    await run("git", ["add", "-A"], { cwd: root });
    await run("git", ["commit", "-m", "init"], { cwd: root });
    await run("git", ["checkout", "-q", "--detach"], { cwd: root });
    return root;
  }

  test("the named path is the inferred path's parser, not a second one", () => {
    expect(requireFeatureBranch("feature/69-media-cli", "flag")).toEqual(parseFeatureBranch("feature/69-media-cli"));
  });

  test.each([
    ["main", "not a feature branch at all"],
    ["feature/nope", "no issue number"],
    ["feature/69-Bad_Slug", "slug is not kebab-case"],
  ])("a malformed name is refused in the inferred path's shape: %s (%s)", (branch) => {
    // **The two refusals, side by side.** The same error, the same code, and a message whose subject is
    // the name it was given — because one parser and one table produce both. Only the remedy differs,
    // and only because only the remedy is about where the name came from.
    const named = refusalFor(() => requireFeatureBranch(branch, "flag"));
    const inferred = refusalFor(() => requireFeatureBranch(branch, "checkout"));
    expect(named).toBeInstanceOf(ValidationError);
    expect(named.payload.code).toBe(inferred.payload.code);
    expect(named.payload.status).toBe(inferred.payload.status);
    expect(named.payload.message).toContain(`(${branch}).`);
    expect(inferred.payload.message).toContain(`(${branch}).`);
    expect(named.payload.action).toContain("feature/<issue>-<slug>");
    // The inferred path's own wording is untouched by any of this — #660 adds a row, it does not edit one.
    expect(inferred.payload.message).toBe(`Not on a feature branch (${branch}).`);
    expect(inferred.payload.action).toBe(
      "Run this from inside a feature worktree, or create one with pithy feature create.",
    );
  });

  test("**the identity resolves from a detached HEAD, where the inferred path cannot**", async () => {
    dir = await detachedCheckout();
    await expect(branchIdentityWithoutWorkers(dir)).rejects.toBeInstanceOf(PithyError);
    expect(await branchIdentityWithoutWorkers(dir, { branch: "feature/12-x" })).toEqual({
      project: "probe",
      issue: "12",
      slug: "x",
    });
  });

  test("with a name in hand the checkout's branch is never read", async () => {
    dir = await detachedCheckout();
    const git: GitRunner = () => {
      throw new Error("the current branch was read");
    };
    expect(await branchIdentityWithoutWorkers(dir, { branch: "feature/12-x", git })).toEqual({
      project: "probe",
      issue: "12",
      slug: "x",
    });
  });

  test("the project comes from the checkout, so --branch cannot name another project's feature", async () => {
    dir = await detachedCheckout();
    await writeFile(join(dir, "pithy.config.ts"), `export default { name: "replay" };\n`);
    expect((await branchIdentityWithoutWorkers(dir, { branch: "feature/12-x" })).project).toBe("replay");
  });
});
