// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  assertDeploysRequestedEnvironment,
  configFromArgs,
  effectiveDeployConfig,
  environmentFromArgs,
  identityOf,
  redirectedConfig,
  wranglerEnvironment,
} from "./effectiveConfig";

describe("wranglerEnvironment", () => {
  test("a declared environment is a wrangler environment", () => {
    expect(wranglerEnvironment("staging")).toBe("staging");
    expect(wranglerEnvironment("feature")).toBe("feature");
  });

  test("a bare deploy and dev both name the top-level stanza, which is not an environment", () => {
    // `DeclaredEnvironments` refuses `dev`, so there is no `env.dev` anywhere in the kit to select. A
    // `--env dev` handed to wrangler asks for a section the project is forbidden from writing.
    expect(wranglerEnvironment(undefined)).toBeUndefined();
    expect(wranglerEnvironment("dev")).toBeUndefined();
  });
});

describe("identityOf", () => {
  const config = {
    name: "acme-web",
    vars: { ENVIRONMENT: "dev" },
    env: { staging: { name: "acme-web-staging", vars: { ENVIRONMENT: "staging" } }, prod: {} },
  };

  test("reads the stanza's own name and vars", () => {
    expect(identityOf("/c", config, "staging", false)).toEqual({
      path: "/c",
      name: "acme-web-staging",
      environment: "staging",
    });
  });

  test("a stanza that names nothing deploys as <top-level name>-<env>, which is wrangler's own rule", () => {
    expect(identityOf("/c", config, "prod", false)).toMatchObject({ name: "acme-web-prod", environment: null });
  });

  test("an environment with no stanza at all still gets the suffix — wrangler reuses the top level", () => {
    // wrangler's `inheritable` applies `appendEnvName` in exactly this case, which is why it is modeled
    // rather than shortcut to "no stanza, no environment".
    expect(identityOf("/c", config, "live", false)).toMatchObject({ name: "acme-web-live", environment: "dev" });
  });

  test("no environment is the top-level stanza, verbatim", () => {
    expect(identityOf("/c", config, undefined, false)).toMatchObject({ name: "acme-web", environment: "dev" });
  });

  test("a redirected config ignores the environment entirely — the mechanism that made #579 silent", () => {
    const built = { name: "acme-web", vars: { ENVIRONMENT: "dev" } };
    expect(identityOf("/b", built, "staging", true)).toMatchObject({ name: "acme-web", environment: "dev" });
  });
});

describe("configFromArgs / environmentFromArgs", () => {
  test("reads both spellings of each flag off the argv about to be run", () => {
    expect(configFromArgs(["deploy", "--config", "/x/wrangler.jsonc"])).toBe("/x/wrangler.jsonc");
    expect(configFromArgs(["deploy", "--config=/x/wrangler.jsonc"])).toBe("/x/wrangler.jsonc");
    expect(configFromArgs(["deploy", "-c", "/x/wrangler.jsonc"])).toBe("/x/wrangler.jsonc");
    expect(configFromArgs(["deploy", "--env", "staging"])).toBeUndefined();
    expect(environmentFromArgs(["deploy", "--env", "staging"])).toBe("staging");
    expect(environmentFromArgs(["deploy", "--env=staging"])).toBe("staging");
    expect(environmentFromArgs(["deploy", "-e", "staging"])).toBe("staging");
    expect(environmentFromArgs(["deploy"])).toBeUndefined();
  });
});

describe("the effective configuration", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-effective-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Write the two files `vite build` leaves behind: the flattened config, and the redirect to it. */
  async function writeBuildOutput(config: Record<string, unknown>): Promise<string> {
    const built = join(dir, "dist", "worker", "wrangler.json");
    await mkdir(join(dir, "dist", "worker"), { recursive: true });
    await writeFile(built, JSON.stringify(config));
    await mkdir(join(dir, ".wrangler", "deploy"), { recursive: true });
    await writeFile(
      join(dir, ".wrangler", "deploy", "config.json"),
      JSON.stringify({ configPath: "../../dist/worker/wrangler.json", auxiliaryWorkers: [] }),
    );
    return built;
  }

  test("no redirect means the Worker's own wrangler.jsonc", async () => {
    expect(await effectiveDeployConfig(dir, ["deploy", "--env", "staging"])).toEqual({
      path: join(dir, "wrangler.jsonc"),
      redirected: false,
    });
  });

  test("a redirect resolves against the directory holding it, as wrangler does", async () => {
    const built = await writeBuildOutput({ name: "acme-web" });
    expect(await redirectedConfig(dir)).toBe(built);
    expect(await effectiveDeployConfig(dir, ["deploy", "--env", "staging"])).toEqual({
      path: built,
      redirected: true,
    });
  });

  test("the redirect is searched for upwards, so a Worker below one still reads it", async () => {
    const built = await writeBuildOutput({ name: "acme-web" });
    const nested = join(dir, "apps", "web");
    await mkdir(nested, { recursive: true });
    expect(await redirectedConfig(nested)).toBe(built);
  });

  test("an explicit --config beats the redirect — measured on wrangler, and the reason it is not the fix", async () => {
    await writeBuildOutput({ name: "acme-web" });
    expect(await effectiveDeployConfig(dir, ["deploy", "--env", "feature", "--config", "/g/wrangler.jsonc"])).toEqual({
      path: "/g/wrangler.jsonc",
      redirected: false,
    });
  });
});

/**
 * **The invariant: a deploy publishes the configuration its project declares for the environment asked
 * for.** Stated that way rather than as "CLOUDFLARE_ENV is set", because the variable is one mechanism
 * and this has already produced two — the build emitting the wrong stanza, and `--config` overriding the
 * one that was built (#579).
 */
describe("assertDeploysRequestedEnvironment", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-effective-gate-"));
    await writeFile(
      join(dir, "wrangler.jsonc"),
      // JSONC, comments and all: the tracked config is the file an adopter writes, not a generated one.
      `{\n  // The Worker.\n  "name": "acme-web",\n  "vars": { "ENVIRONMENT": "dev" },\n  "env": { "staging": { "name": "acme-web-staging", "vars": { "ENVIRONMENT": "staging" } } }\n}\n`,
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeBuilt(config: Record<string, unknown>): Promise<string> {
    const built = join(dir, "dist", "worker", "wrangler.json");
    await mkdir(join(dir, "dist", "worker"), { recursive: true });
    await writeFile(built, JSON.stringify(config));
    await mkdir(join(dir, ".wrangler", "deploy"), { recursive: true });
    await writeFile(
      join(dir, ".wrangler", "deploy", "config.json"),
      JSON.stringify({ configPath: "../../dist/worker/wrangler.json" }),
    );
    return built;
  }

  const refusal = (args: string[], env: string | undefined = "staging"): Promise<unknown> =>
    assertDeploysRequestedEnvironment({ workerDir: dir, env, args }).catch((error: unknown) => error);

  test("holds when nothing has substituted a configuration", async () => {
    await expect(
      assertDeploysRequestedEnvironment({ workerDir: dir, env: "staging", args: ["deploy", "--env", "staging"] }),
    ).resolves.toBeUndefined();
  });

  test("holds when the build output is the requested environment's", async () => {
    await writeBuilt({ name: "acme-web-staging", vars: { ENVIRONMENT: "staging" } });
    await expect(
      assertDeploysRequestedEnvironment({ workerDir: dir, env: "staging", args: ["deploy", "--env", "staging"] }),
    ).resolves.toBeUndefined();
  });

  test("refuses the build output that is the top-level stanza — #579, exactly", async () => {
    const built = await writeBuilt({ name: "acme-web", vars: { ENVIRONMENT: "dev" } });
    const error = (await refusal(["deploy", "--env", "staging"])) as PithyError;
    expect(error).toBeInstanceOf(PithyError);
    expect(error.payload.message).toContain(built);
    expect(error.payload.detail).toContain("acme-web-staging");
    expect(error.payload.detail).toContain("ENVIRONMENT=dev");
  });

  test("refuses a build output carrying another environment's name", async () => {
    await writeBuilt({ name: "acme-web-prod", vars: { ENVIRONMENT: "prod" } });
    expect((await refusal(["deploy", "--env", "staging"])) as PithyError).toBeInstanceOf(PithyError);
  });

  test("refuses a build output whose ENVIRONMENT var is another environment's, name or no name", async () => {
    // The var is what `compositionEnvironment` reads, and reading `dev` is what mounted a dev login route
    // on a public URL. A config that got the script name right and the var wrong is still not staging's.
    await writeBuilt({ name: "acme-web-staging", vars: { ENVIRONMENT: "dev" } });
    const error = (await refusal(["deploy", "--env", "staging"])) as PithyError;
    expect(error).toBeInstanceOf(PithyError);
    expect(error.payload.detail).toContain("ENVIRONMENT=dev");
  });

  test("refuses an argv that lost its --env, even with nothing substituted", async () => {
    // Same file on both sides, and the comparison is still real: the declaration is resolved for the
    // environment REQUESTED and the effective config for the one this ARGV selects.
    const error = (await refusal(["deploy"])) as PithyError;
    expect(error).toBeInstanceOf(PithyError);
    expect(error.payload.detail).toContain("acme-web-staging");
  });

  test("refuses an argv naming a different environment than the one requested", async () => {
    expect((await refusal(["deploy", "--env", "prod"])) as PithyError).toBeInstanceOf(PithyError);
  });

  test("refuses when the effective configuration is not there at all", async () => {
    await mkdir(join(dir, ".wrangler", "deploy"), { recursive: true });
    await writeFile(
      join(dir, ".wrangler", "deploy", "config.json"),
      JSON.stringify({ configPath: "../../dist/worker/wrangler.json" }),
    );
    const error = (await refusal(["deploy", "--env", "staging"])) as PithyError;
    expect(error).toBeInstanceOf(PithyError);
    expect(error.payload.message).toContain("wrangler.json");
  });

  test("a bare deploy is held to the top-level stanza, which is the environment it asked for", async () => {
    await writeBuilt({ name: "acme-web", vars: { ENVIRONMENT: "dev" } });
    await expect(
      assertDeploysRequestedEnvironment({ workerDir: dir, env: undefined, args: ["deploy"] }),
    ).resolves.toBeUndefined();
    await writeBuilt({ name: "acme-web-staging", vars: { ENVIRONMENT: "staging" } });
    const error = await assertDeploysRequestedEnvironment({ workerDir: dir, env: undefined, args: ["deploy"] }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(PithyError);
  });

  test("a feature environment is held to its generated config, not to the tracked one", async () => {
    await mkdir(join(dir, ".wrangler", "pithy"), { recursive: true });
    await writeFile(
      join(dir, ".wrangler", "pithy", "wrangler.feature.jsonc"),
      JSON.stringify({
        name: "acme-web",
        env: { feature: { name: "acme-web-pr-7", vars: { ENVIRONMENT: "feature" } } },
      }),
    );
    await writeBuilt({ name: "acme-web-pr-7", vars: { ENVIRONMENT: "feature" } });
    await expect(
      assertDeploysRequestedEnvironment({ workerDir: dir, env: "feature", args: ["deploy", "--env", "feature"] }),
    ).resolves.toBeUndefined();

    await writeBuilt({ name: "acme-web", vars: { ENVIRONMENT: "dev" } });
    const error = (await refusal(["deploy", "--env", "feature"], "feature")) as PithyError;
    expect(error).toBeInstanceOf(PithyError);
    expect(error.payload.detail).toContain("acme-web-pr-7");
  });

  test("refuses a declaration that says nothing this deploy could be held to", async () => {
    await writeFile(join(dir, "wrangler.jsonc"), JSON.stringify({ main: "src/index.ts" }));
    await writeBuilt({ name: "acme-web" });
    const error = (await refusal(["deploy", "--env", "staging"])) as PithyError;
    expect(error).toBeInstanceOf(PithyError);
    expect(error.payload.message).toContain("says nothing about staging");
  });

  test("a Worker with no configuration at all is not this gate's to refuse", async () => {
    const empty = join(dir, "nothing");
    await mkdir(empty, { recursive: true });
    await expect(
      assertDeploysRequestedEnvironment({ workerDir: empty, env: "staging", args: ["deploy", "--env", "staging"] }),
    ).resolves.toBeUndefined();
  });
});
