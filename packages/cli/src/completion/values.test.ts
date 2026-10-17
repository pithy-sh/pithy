// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ENVIRONMENTS } from "@pithy-sh/core/src/naming/environment";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CATALOG } from "../capabilities/catalog";
import { GIT_NO_MAINTENANCE, removeTempDir } from "../test-utils/tempRepo";
import { defaultSources, type ValueSources, valuesFor } from "./values";

const run = promisify(execFile);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-complete-values-"));
});
afterEach(async () => {
  await removeTempDir(dir);
});

/** A Pithy project in `dir`: the root config and two Workers. */
async function project(): Promise<void> {
  await writeFile(join(dir, "pithy.config.ts"), "export default {};\n");
  for (const worker of ["web", "api"]) {
    await mkdir(join(dir, "apps", worker), { recursive: true });
    await writeFile(join(dir, "apps", worker, "wrangler.jsonc"), JSON.stringify({ name: `acme-${worker}` }));
  }
}

describe("defaultSources", () => {
  test("the environments are the kit's three", () => {
    expect(defaultSources.environments()).toEqual([...ENVIRONMENTS]);
  });

  test("the capabilities are the catalog's, each with why a project would enable it", () => {
    expect(defaultSources.capabilities()).toEqual(
      CATALOG.map((entry) => ({ value: entry.name, description: entry.whenToEnable })),
    );
  });

  test("the Workers are the project's, by directory", async () => {
    await project();
    expect(await defaultSources.workers(dir)).toEqual(["api", "web"]);
  });

  test("outside a Pithy project there are no Workers, whatever apps/ holds", async () => {
    await mkdir(join(dir, "apps", "web"), { recursive: true });
    await writeFile(join(dir, "apps", "web", "wrangler.jsonc"), "{}");
    expect(await defaultSources.workers(dir)).toEqual([]);
  });

  test("the feature branches are the repository's feature/ branches, and nothing else", async () => {
    await project();
    const git = (...args: string[]) => run("git", [...GIT_NO_MAINTENANCE, ...args], { cwd: dir });
    await git("init", "--quiet", "--initial-branch=main");
    await git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "x");
    await git("branch", "feature/12-media-cli");
    await git("branch", "feature/7-auth");
    await git("branch", "spike");
    expect(await defaultSources.featureBranches(dir)).toEqual(["feature/12-media-cli", "feature/7-auth"]);
  });

  test("outside a repository there are no feature branches, and nothing throws", async () => {
    await project();
    expect(await defaultSources.featureBranches(dir)).toEqual([]);
  });

  test("outside a Pithy project there are no feature branches either", async () => {
    expect(await defaultSources.featureBranches(dir)).toEqual([]);
  });
});

describe("valuesFor", () => {
  const sources: ValueSources = {
    environments: () => ["dev", "staging", "prod"],
    capabilities: () => [{ value: "auth", description: "Sign-in" }],
    workers: async () => ["api"],
    featureBranches: async () => ["feature/1-x"],
  };
  const at = (query: Parameters<typeof valuesFor>[0]) => valuesFor(query, "/nowhere", sources);

  test("a fixed set wins over everything", async () => {
    expect(await at({ path: ["deploy"], flag: "env", enum: ["a"] })).toEqual([{ value: "a", description: "" }]);
  });

  test("--env anywhere is the environments", async () => {
    expect((await at({ path: ["migrate"], flag: "env" })).map((c) => c.value)).toEqual(["dev", "staging", "prod"]);
  });

  test("--worker and --app anywhere are the Workers", async () => {
    expect(await at({ path: ["seed"], flag: "worker" })).toEqual([{ value: "api", description: "" }]);
    expect(await at({ path: ["dev"], flag: "app" })).toEqual([{ value: "api", description: "" }]);
  });

  test("feature destroy --branch is the feature branches, and only there", async () => {
    expect(await at({ path: ["feature", "destroy"], flag: "branch" })).toEqual([
      { value: "feature/1-x", description: "" },
    ]);
    expect(await at({ path: ["other"], flag: "branch" })).toEqual([]);
  });

  test("add and remove take a capability", async () => {
    expect(await at({ path: ["add"], positional: "capability" })).toEqual([{ value: "auth", description: "Sign-in" }]);
    expect(await at({ path: ["remove"], positional: "capability" })).toEqual([
      { value: "auth", description: "Sign-in" },
    ]);
  });

  test("pithy env takes an environment", async () => {
    expect((await at({ path: ["env"], positional: "name" })).map((c) => c.value)).toEqual(["dev", "staging", "prod"]);
  });

  test("a value a shell would read as syntax is never offered, so a Tab cannot type a command", async () => {
    const hostile: ValueSources = {
      ...sources,
      workers: async () => ["api", "$(touch pwned)", "a b", "`id`", "x;y", "w|z", "q'uote", "@(1)", "a,b"],
      featureBranches: async () => ["feature/1-x", "feature/$(id)", "feature/a&b"],
    };
    const values = async (query: Parameters<typeof valuesFor>[0]) =>
      (await valuesFor(query, "/nowhere", hostile)).map((c) => c.value);
    expect(await values({ path: ["dev"], flag: "app" })).toEqual(["api"]);
    expect(await values({ path: ["feature", "destroy"], flag: "branch" })).toEqual(["feature/1-x"]);
  });

  test("the names a project really uses pass the filter", async () => {
    const real: ValueSources = {
      ...sources,
      workers: async () => ["web", "api_v2", "docs.site"],
      featureBranches: async () => ["feature/12-media-cli", "feature/7-auth+sso", "feature/v1.2:fix=x"],
    };
    const values = async (query: Parameters<typeof valuesFor>[0]) =>
      (await valuesFor(query, "/nowhere", real)).map((c) => c.value);
    expect(await values({ path: ["dev"], flag: "worker" })).toEqual(["web", "api_v2", "docs.site"]);
    expect(await values({ path: ["feature", "destroy"], flag: "branch" })).toEqual([
      "feature/12-media-cli",
      "feature/7-auth+sso",
      "feature/v1.2:fix=x",
    ]);
  });

  test("anything else completes nothing", async () => {
    expect(await at({ path: ["secrets", "create"], positional: "name" })).toEqual([]);
    expect(await at({ path: ["init"], flag: "dir" })).toEqual([]);
  });
});
