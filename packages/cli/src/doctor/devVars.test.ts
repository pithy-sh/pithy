// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUDFLARE_ENV_KEYS } from "@pithy-sh/cloudflare/src/env/devVars";
import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GENERATED_HEADER } from "../devSecrets/generate";
import type { DevSecretsTarget } from "../devSecrets/seed";
import type { StatePathOptions } from "../notifier/state";
import {
  checkDevVars,
  type DevVarsCheck,
  describeDevVars,
  devVarsHealthy,
  isCloudflareEnvKey,
  ROOT_DEV_VAR_STATES,
  type RootDevVarState,
} from "./devVars";

const registry = defineSecretRegistry({
  "auth-session-secret": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
  CONNECTION_KEY_ENCRYPTION_KEY: {
    backend: "cf-secrets-store",
    scope: "environment",
    rotatable: false,
    valueType: "text",
    devValue: "random",
  },
});

/** The secrets capability's own shape: a binding whose dev value never comes from a registry. */
const composes = (...names: string[]): Capability[] =>
  names.map((name) => ({ name, requiredBindings: [{ type: "secret", name }] }) as unknown as Capability);

let dir: string;
let config: string;

function paths(): StatePathOptions {
  return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: config } };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-dev-vars-"));
  config = await mkdtemp(join(tmpdir(), "pithy-dev-vars-config-"));
  // Deliberately not the Worker's name. A fixture where the project and the Worker share one string
  // hides every defect that reads the wrong one of the two — see #136.
  await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "replay" };\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

/** A Worker directory with a `wrangler.jsonc`, and whatever capabilities the test says it composes. */
async function worker(name: string, config: unknown, capabilities: Capability[] = []) {
  const path = join(dir, "apps", name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "wrangler.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
  return { name, dir: path, capabilities };
}

/** A generated `.dev.vars`, as `renderDevVars` writes one: the header, a blank line, then the values. */
async function generated(workerDir: string, values: Record<string, string> = {}) {
  const lines = [...GENERATED_HEADER, "", ...Object.entries(values).map(([key, value]) => `${key}=${value}`)];
  await writeFile(join(workerDir, ".dev.vars"), `${lines.join("\n")}\n`);
}

function targets(dirs: { name: string; dir: string }[]): DevSecretsTarget[] {
  return dirs.map((entry) => ({ name: entry.name, dir: entry.dir, registry }));
}

function check(workers: { name: string; dir: string; capabilities: Capability[] }[]): Promise<DevVarsCheck> {
  return checkDevVars({ projectDir: dir, workers, targets: targets(workers), paths: paths() });
}

describe("the generated .dev.vars — is the Worker getting anything", () => {
  /**
   * #178, reproduced: the dashboard's `apps/board/.dev.vars` was a header and nothing else, and the
   * first thing that said so was a 500 from a running Worker naming the bindings it did not have.
   */
  test("a generated file with a header and no values names the Worker", async () => {
    const board = await worker("board", { vars: {} });
    await generated(board.dir);

    const result = await check([board]);

    expect(result.empty).toEqual([{ worker: "board", file: join("apps", "board", ".dev.vars") }]);
    expect(describeDevVars(result)[0]).toContain("board");
    expect(describeDevVars(result)[0]).toContain(join("apps", "board", ".dev.vars"));
    expect(devVarsHealthy(result)).toBe(false);
  });

  test("a generated file with values is silent — that is the working state", async () => {
    const board = await worker("board", { vars: {} });
    await generated(board.dir, { SECRETS_ENCRYPTION_KEYS: "{}" });
    expect((await check([board])).empty).toEqual([]);
  });

  test("no file at all is not a finding — nothing has generated one yet, and pithy dev will", async () => {
    const board = await worker("board", { vars: {} });
    expect((await check([board])).empty).toEqual([]);
  });

  test("a .dev.vars pithy did not write is the adopter's, and is not judged here", async () => {
    // `generateDevVars` refuses to touch one without the marker. Reading its contents to grade them
    // would be the same overreach one report further along.
    const board = await worker("board", { vars: {} });
    await writeFile(join(board.dir, ".dev.vars"), "# mine\n");
    expect((await check([board])).empty).toEqual([]);
  });

  test("each Worker is judged on its own file, and the empty one is named", async () => {
    const board = await worker("board", { vars: {} });
    const web = await worker("web", { vars: {} });
    await generated(board.dir);
    await generated(web.dir, { PUBLIC_URL: "http://localhost" });

    expect((await check([board, web])).empty.map((entry) => entry.worker)).toEqual(["board"]);
  });
});

describe("the root .dev.vars — is anything reading it", () => {
  test("a Cloudflare credential is where it belongs and says nothing", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_ACCOUNT_ID=abc\nCLOUDFLARE_API_TOKEN=tok\n");

    const result = await check([board]);

    expect(result.root.map((entry) => entry.state)).toEqual(["credential", "credential"]);
    expect(describeDevVars(result)).toEqual([]);
    expect(devVarsHealthy(result)).toBe(true);
  });

  test("every key the CLI reads out of that file is silent, so a fourth one cannot arrive noisy", async () => {
    // The gate, stated as the invariant: the root `.dev.vars` is the CLI's file, and
    // `CLOUDFLARE_ENV_KEYS` is the whole list of what it reads from it. Add a key there and this
    // passes; classify by anything else and it fails.
    const board = await worker("board", { vars: {} });
    await writeFile(join(dir, ".dev.vars"), CLOUDFLARE_ENV_KEYS.map((key) => `${key}=x`).join("\n"));

    const result = await check([board]);

    expect(result.root.every((entry) => entry.state === "credential")).toBe(true);
    expect(describeDevVars(result)).toEqual([]);
  });

  test("a registry secret is left to checkDevSecrets, which says which file it belongs in", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=old\nCONNECTION_KEY_ENCRYPTION_KEY=k\n");

    const result = await check([board]);

    expect(result.root.map((entry) => entry.state)).toEqual(["secret", "secret"]);
    // One finding, one sentence. Two checks naming the same key twice is a report nobody finishes.
    expect(describeDevVars(result)).toEqual([]);
  });

  /**
   * The dashboard's `SECRETS_ENCRYPTION_KEYS`: a value that is real, that a Worker requires as a
   * binding, and that no Worker reads from this file. Classifying it as "nothing reads this" would
   * advise deleting the project's dev master key, so the composed set has to be known before the
   * "nothing reads this" case can be stated safely.
   */
  test("a binding the project composes is named as stranded, never as deletable", async () => {
    const board = await worker("board", { vars: {} }, composes("SECRETS_ENCRYPTION_KEYS"));
    await writeFile(join(dir, ".dev.vars"), "SECRETS_ENCRYPTION_KEYS={}\n");

    const result = await check([board]);

    expect(result.root).toEqual([{ key: "SECRETS_ENCRYPTION_KEYS", state: "binding", workers: ["board"] }]);
    const line = describeDevVars(result).join("\n");
    expect(line).toContain("SECRETS_ENCRYPTION_KEYS");
    expect(line).toContain("board");
    expect(line).toContain("no Worker reads");
    expect(line).not.toContain("Delete it");
  });

  test("a name declared in wrangler.jsonc vars counts as composed too — even in one environment only", async () => {
    const board = await worker("board", { vars: {}, env: { staging: { vars: { REGION: "weur" } } } });
    await writeFile(join(dir, ".dev.vars"), "REGION=local\n");
    expect((await check([board])).root.map((entry) => entry.state)).toEqual(["binding"]);
  });

  test("a key nothing declares is the nothing-reads-this case, and is told to go", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(dir, ".dev.vars"), "LEFTOVER_FROM_2024=x\n");

    const result = await check([board]);

    expect(result.root).toEqual([{ key: "LEFTOVER_FROM_2024", state: "unread", workers: [] }]);
    expect(describeDevVars(result).join("\n")).toContain("nothing reads it");
    expect(devVarsHealthy(result)).toBe(false);
  });

  test("no root file is no keys, and nothing to say", async () => {
    const board = await worker("board", { vars: {} });
    const result = await check([board]);
    expect(result.root).toEqual([]);
    expect(devVarsHealthy(result)).toBe(true);
  });

  /**
   * The invariant the whole module turns on: **every** key in that file is classified. The `d1`-only
   * check next door failed precisely by having a class of key that reached no branch, so a fixture
   * carrying one of each shape must come back with one verdict per key and no key unaccounted for.
   */
  test("every key in the file is classified exactly once — nothing falls through", async () => {
    const board = await worker("board", { vars: {} }, composes("SECRETS_ENCRYPTION_KEYS"));
    const keys = ["CLOUDFLARE_API_TOKEN", "auth-session-secret", "SECRETS_ENCRYPTION_KEYS", "LEFTOVER_FROM_2024"];
    await writeFile(join(dir, ".dev.vars"), keys.map((key) => `${key}=x`).join("\n"));

    const result = await check([board]);

    expect(result.root.map((entry) => entry.key).sort()).toEqual([...keys].sort());
    expect(new Set(result.root.map((entry) => entry.state))).toEqual(new Set(ROOT_DEV_VAR_STATES));
  });

  test("every state either prints a sentence or is another check's to print — none is merely forgotten", () => {
    // Add a state to `ROOT_DEV_VAR_STATES` and this fails until it is either given a sentence or
    // deliberately assigned to the check that owns it. The two silent ones are named, not defaulted.
    const silent: RootDevVarState[] = ["credential", "secret"];
    for (const state of ROOT_DEV_VAR_STATES) {
      const lines = describeDevVars({
        root: [{ key: "SOME_KEY", state, workers: ["board"] }],
        empty: [],
        devConfigPath: "/config/replay/dev.json",
      });
      expect(lines.length === 0).toBe(silent.includes(state));
    }
  });

  test("no value ever reaches the report", async () => {
    const board = await worker("board", { vars: {} });
    await writeFile(join(dir, ".dev.vars"), "LEFTOVER=s3cr3t\n");

    const result = await check([board]);

    expect(JSON.stringify(result)).not.toContain("s3cr3t");
    expect(describeDevVars(result).join("\n")).not.toContain("s3cr3t");
  });

  test("names this machine's dev config, resolved from the project's name and not guessed", async () => {
    const board = await worker("board", { vars: {} }, composes("SECRETS_ENCRYPTION_KEYS"));
    await writeFile(join(dir, ".dev.vars"), "SECRETS_ENCRYPTION_KEYS={}\n");

    const result = await check([board]);

    expect(result.devConfigPath).toBe(join(config, "replay", "dev.json"));
    expect(describeDevVars(result).join("\n")).toContain(join(config, "replay", "dev.json"));
  });
});

describe("isCloudflareEnvKey", () => {
  test("is the readers' own list, not a backend proxy", () => {
    for (const key of CLOUDFLARE_ENV_KEYS) expect(isCloudflareEnvKey(key)).toBe(true);
    expect(isCloudflareEnvKey("CONNECTION_KEY_ENCRYPTION_KEY")).toBe(false);
    expect(isCloudflareEnvKey("auth-session-secret")).toBe(false);
  });
});
