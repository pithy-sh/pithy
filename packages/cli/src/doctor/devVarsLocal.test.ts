// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DevSecretsTarget } from "../devSecrets/targets";
import { checkDevVarsLocal, describeDevVarsLocal } from "./devVarsLocal";

const registry = defineSecretRegistry({
  "auth-session-secret": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
});

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-local-vars-"));
  await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "replay" };\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A Worker whose `wrangler.jsonc` declares exactly `config`. */
async function worker(name: string, config: unknown): Promise<string> {
  const path = join(dir, "apps", name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "wrangler.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

function targets(dirs: string[]): DevSecretsTarget[] {
  return dirs.map((path) => ({ name: "board", dir: path, registry }));
}

describe("checkDevVarsLocal", () => {
  test("a project with no .dev.vars.local anywhere has nothing to say", async () => {
    const board = await worker("board", { vars: { ENVIRONMENT: "dev" } });
    expect(await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) })).toBeNull();
  });

  test("a key that exists only in dev is named — that failure otherwise lands at deploy", async () => {
    const board = await worker("board", { vars: { ENVIRONMENT: "dev" } });
    await writeFile(join(dir, ".dev.vars.local"), "FEATURE_FLAG=1\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) });

    expect(check?.devOnly).toEqual([{ key: "FEATURE_FLAG", file: ".dev.vars.local" }]);
    expect(describeDevVarsLocal(check ?? { devOnly: [], shadowing: [] })[0]).toContain("wrangler.jsonc vars");
  });

  test("a key declared in wrangler.jsonc vars is not dev-only", async () => {
    const board = await worker("board", { vars: { ENVIRONMENT: "dev" } });
    await writeFile(join(dir, ".dev.vars.local"), "ENVIRONMENT=staging\n");

    expect(await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) })).toBeNull();
  });

  test("env.<name>.vars REPLACES the top level, so a key declared only there still counts", async () => {
    // The starter's own `wrangler.jsonc` warns about this: every environment repeats every variable.
    // Reading the top level alone would name a staging-only variable as one that exists only in dev.
    const board = await worker("board", { vars: {}, env: { staging: { vars: { REGION: "weur" } } } });
    await writeFile(join(dir, ".dev.vars.local"), "REGION=local\n");

    expect(await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) })).toBeNull();
  });

  test("a key that shadows a registry secret is legitimate, and never invisible", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(board, ".dev.vars.local"), "auth-session-secret=mine\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) });

    expect(check?.shadowing).toEqual([{ key: "auth-session-secret", file: join("apps", "board", ".dev.vars.local") }]);
    expect(check?.devOnly).toEqual([]);
    expect(describeDevVarsLocal(check ?? { devOnly: [], shadowing: [] })[0]).toContain("shadows");
  });

  test("the root file is judged against every Worker's vars, because it reaches every Worker", async () => {
    const board = await worker("board", { vars: { ENVIRONMENT: "dev" } });
    const web = await worker("web", { vars: { PUBLIC_URL: "http://localhost" } });
    await writeFile(join(dir, ".dev.vars.local"), "PUBLIC_URL=http://elsewhere\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board, web], targets: targets([board]) });

    expect(check).toBeNull();
  });

  test("no value ever reaches the report", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(dir, ".dev.vars.local"), "TOKEN=s3cr3t\n");

    const check = await checkDevVarsLocal({ projectDir: dir, workerDirs: [board], targets: targets([board]) });

    expect(JSON.stringify(check)).not.toContain("s3cr3t");
    expect(describeDevVarsLocal(check ?? { devOnly: [], shadowing: [] }).join("\n")).not.toContain("s3cr3t");
  });
});
