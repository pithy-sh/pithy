// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  assertDeploysRequestedEnvironment,
  assertPublishesDeclaredWorker,
  configFromArgs,
  effectiveDeployConfig,
  environmentFromArgs,
  identityOf,
  redirectedConfig,
  selectedEnvironment,
  TOP_LEVEL_STANZA_ARG,
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

/**
 * **wrangler's own precedence, `args.env ?? getCloudflareEnv()`, read out of wrangler 4.131.2.**
 *
 * The argv is one of two inputs and was the only one this module read. `CLOUDFLARE_ENV` is the other,
 * and it is the one an operator exports once and forgets — so a bare `pithy deploy` in that shell
 * publishes the exported stanza while an argv-only reading expects the top level.
 */
describe("selectedEnvironment", () => {
  test("the argv wins, whatever the environment says", () => {
    expect(selectedEnvironment(["deploy", "--env", "staging"], { CLOUDFLARE_ENV: "prod" })).toBe("staging");
    expect(selectedEnvironment(["deploy", "-e", "staging"], { CLOUDFLARE_ENV: "prod" })).toBe("staging");
  });

  test("CLOUDFLARE_ENV selects the stanza when the argv names none", () => {
    expect(selectedEnvironment(["deploy"], { CLOUDFLARE_ENV: "prod" })).toBe("prod");
  });

  test("nothing selected is the top-level stanza", () => {
    expect(selectedEnvironment(["deploy"], {})).toBeUndefined();
  });

  test("an empty value selects nothing, because wrangler branches on truthiness", () => {
    // `if (envName)` in wrangler's `normalizeAndValidateConfig`, not `!== undefined`. An empty string
    // is how a script says "the top level" without unsetting an inherited variable.
    expect(selectedEnvironment(["deploy"], { CLOUDFLARE_ENV: "" })).toBeUndefined();
    expect(selectedEnvironment(["deploy", "--env="], { CLOUDFLARE_ENV: "prod" })).toBeUndefined();
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

  /**
   * The gate, with nothing in the environment. Every case states the environment wrangler will inherit,
   * so what a case proves is the code's behavior and not the developer's exported `CLOUDFLARE_ENV`.
   */
  const refusal = (
    args: string[],
    env: string | undefined = "staging",
    processEnv: NodeJS.ProcessEnv = {},
  ): Promise<unknown> =>
    assertDeploysRequestedEnvironment({ workerDir: dir, env, args, processEnv }).catch((error: unknown) => error);

  test("holds when nothing has substituted a configuration", async () => {
    await expect(
      assertDeploysRequestedEnvironment({
        workerDir: dir,
        env: "staging",
        args: ["deploy", "--env", "staging"],
        processEnv: {},
      }),
    ).resolves.toBeUndefined();
  });

  test("holds when the build output is the requested environment's", async () => {
    await writeBuilt({ name: "acme-web-staging", vars: { ENVIRONMENT: "staging" } });
    await expect(
      assertDeploysRequestedEnvironment({
        workerDir: dir,
        env: "staging",
        args: ["deploy", "--env", "staging"],
        processEnv: {},
      }),
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

  test("refuses a bare deploy that an exported CLOUDFLARE_ENV turns into another environment's", async () => {
    // The gate's own subject, reached by the input the gate did not read. wrangler resolves
    // `args.env ?? getCloudflareEnv()`, so this argv publishes `env.staging` while a reading of the argv
    // alone expects the top-level stanza — and blesses it.
    const error = (await assertDeploysRequestedEnvironment({
      workerDir: dir,
      env: undefined,
      args: ["deploy"],
      processEnv: { CLOUDFLARE_ENV: "staging" },
    }).catch((thrown: unknown) => thrown)) as PithyError;
    expect(error).toBeInstanceOf(PithyError);
    expect(error.payload.detail).toContain("acme-web-staging");
    expect(error.payload.action).toContain("CLOUDFLARE_ENV=staging");
  });

  test("refuses a dev deploy the same way, because dev is the top-level stanza", async () => {
    // `--env dev` reaches wrangler as no `--env` at all, so the exported variable is what selects. The
    // requested environment is dev's top-level stanza; `env.prod` is not it.
    const error = (await refusal(["deploy"], "dev", { CLOUDFLARE_ENV: "prod" })) as PithyError;
    expect(error).toBeInstanceOf(PithyError);
    expect(error.payload.detail).toContain("acme-web-prod");
  });

  test("holds when the argv names the environment, whatever the shell exported", async () => {
    // wrangler's precedence, not a preference of ours: `--env` on the argv is read before the variable,
    // so an operator with `CLOUDFLARE_ENV=prod` exported still deploys staging when they ask for it.
    await expect(
      assertDeploysRequestedEnvironment({
        workerDir: dir,
        env: "staging",
        args: ["deploy", "--env", "staging"],
        processEnv: { CLOUDFLARE_ENV: "prod" },
      }),
    ).resolves.toBeUndefined();
  });

  test("holds when CLOUDFLARE_ENV is empty, which wrangler reads as the top-level stanza", async () => {
    await expect(
      assertDeploysRequestedEnvironment({
        workerDir: dir,
        env: undefined,
        args: ["deploy"],
        processEnv: { CLOUDFLARE_ENV: "" },
      }),
    ).resolves.toBeUndefined();
  });

  test("names the argv, not the variable, when the argv is what disagrees", async () => {
    // The action an operator is handed has to be the one that fixes their deploy. Telling someone to
    // unset a variable they never set is a refusal they will route around.
    const error = (await refusal(["deploy", "--env", "prod"])) as PithyError;
    expect(error.payload.action).not.toContain("CLOUDFLARE_ENV");
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
      assertDeploysRequestedEnvironment({ workerDir: dir, env: undefined, args: ["deploy"], processEnv: {} }),
    ).resolves.toBeUndefined();
    await writeBuilt({ name: "acme-web-staging", vars: { ENVIRONMENT: "staging" } });
    const error = await assertDeploysRequestedEnvironment({
      workerDir: dir,
      env: undefined,
      args: ["deploy"],
      processEnv: {},
    }).catch((thrown: unknown) => thrown);
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
      assertDeploysRequestedEnvironment({
        workerDir: dir,
        env: "feature",
        args: ["deploy", "--env", "feature"],
        processEnv: {},
      }),
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
      assertDeploysRequestedEnvironment({
        workerDir: empty,
        env: "staging",
        args: ["deploy", "--env", "staging"],
        processEnv: {},
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * **The other half of the class, on the path that has no declaration to be held to.**
 *
 * A capability host's configuration is generated, not tracked: one complete file per environment, whose
 * `name` already carries the environment (`acme-prod-email`) and whose `env` section does not exist. So
 * there is no second file to compare it against, and the invariant has to be stated about the file
 * itself — the Worker it declares is the Worker that gets published, whatever shell the command was run
 * from.
 *
 * Two checks, because one of them is green in the shell the defect was written in. #584's `hostDeploy`
 * published `<name>-prod` for anyone with `CLOUDFLARE_ENV=prod` exported and `<name>` for everyone else,
 * and an assertion about the name alone would have passed on the machine that wrote it.
 */
describe("assertPublishesDeclaredWorker", () => {
  /** One resolved host config, as `deployHostWorker` writes it. No `env` section — there never is one. */
  const host = { name: "acme-prod-email", vars: { ENVIRONMENT: "prod" } };
  const path = "/pkg/worker/.wrangler.prod.json";

  /** The refusal one argv raises under one shell, or `null` when the gate let it through. */
  function refused(args: readonly string[], processEnv: NodeJS.ProcessEnv): PithyError | null {
    try {
      assertPublishesDeclaredWorker({ configPath: path, config: host, args, processEnv });
      return null;
    } catch (thrown) {
      return thrown as PithyError;
    }
  }

  test("holds an argv that states the top-level stanza, whatever the shell exported", () => {
    expect(refused(["deploy", "--config", path, TOP_LEVEL_STANZA_ARG], { CLOUDFLARE_ENV: "prod" })).toBeNull();
    expect(refused(["deploy", "--config", path, TOP_LEVEL_STANZA_ARG], {})).toBeNull();
  });

  test("refuses when an exported CLOUDFLARE_ENV would append itself to the declared name", () => {
    // #584 exactly. wrangler's `appendEnvName` runs whether or not the stanza exists, so a generated
    // config with no `env` section publishes `acme-prod-email-prod` — a Worker nothing references.
    const error = refused(["deploy", "--config", path], { CLOUDFLARE_ENV: "prod" });
    expect(error).toBeInstanceOf(PithyError);
    expect(error?.payload.detail).toContain("acme-prod-email-prod");
    expect(error?.payload.action).toContain("CLOUDFLARE_ENV=prod");
  });

  test("refuses an argv that states no stanza even in a shell that exports none", () => {
    // The half that has a symptom everywhere. An argv leaving the stanza to `CLOUDFLARE_ENV` publishes
    // the right Worker on the machine it was written on and the wrong one on the next, which is how this
    // survived a green suite twice. The gate reads the argv, so there is no shell it passes in.
    const error = refused(["deploy", "--config", path], {});
    expect(error).toBeInstanceOf(PithyError);
    expect(error?.payload.action).toContain(TOP_LEVEL_STANZA_ARG);
  });

  test("holds an argv that states a stanza whose name is the declared one", () => {
    // Not a shape the kit writes, and the gate is about the published name rather than about a flag: a
    // host config that grew an `env.prod` naming the same Worker is deployed, not refused.
    const staged = { name: "acme-prod-email", env: { prod: { name: "acme-prod-email" } } };
    expect(() =>
      assertPublishesDeclaredWorker({
        configPath: path,
        config: staged,
        args: ["deploy", "--config", path, "--env", "prod"],
        processEnv: {},
      }),
    ).not.toThrow();
  });

  test("refuses a configuration that names no Worker, rather than holding it to nothing", () => {
    const error = (() => {
      try {
        assertPublishesDeclaredWorker({
          configPath: path,
          config: { vars: {} },
          args: ["deploy", "--config", path, TOP_LEVEL_STANZA_ARG],
          processEnv: {},
        });
        return null;
      } catch (thrown) {
        return thrown as PithyError;
      }
    })();
    expect(error).toBeInstanceOf(PithyError);
    expect(error?.payload.message).toContain("names no Worker");
  });
});
