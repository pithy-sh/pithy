// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { masterKeyRegistryEntry } from "@pithy-sh/secrets/src/capability";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/masterKeyBinding";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, describe, expect, test } from "vitest";
import { readDevSecrets } from "../devSecrets/file";
import type { DevSecretsTarget } from "../devSecrets/targets";
import { removeTempDir } from "../test-utils/tempRepo";
import { mintLocalSecrets } from "./mint";

/**
 * **`pithy setup` mints the local secrets the kit can mint, and only those, and only when absent (#764).** The
 * master key, and every registry secret with a dev value. It never edits `pithy.config.ts` — which is what makes
 * it not `pithy add secrets` — and the fifth clone of a project reuses what the first one minted.
 */

const registry = defineSecretRegistry({
  SECRETS_ENCRYPTION_KEYS: masterKeyRegistryEntry,
  "auth-session-secret": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
  "auth-github-client-secret": { backend: "d1", scope: "environment", rotatable: false, valueType: "text" },
});

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

let projects = 0;
/** One clone of project `name`. Every clone of one project on a machine shares its config directory. */
async function clone(name: string): Promise<{ dir: string; targets: DevSecretsTarget[] }> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-setup-mint-"));
  dirs.push(dir);
  await writeFile(join(dir, "pithy.config.ts"), `export default { name: "${name}" };\n`);
  return { dir, targets: [{ name: "api", dir: join(dir, "apps", "api"), registry }] };
}

async function configDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-setup-mint-config-"));
  dirs.push(dir);
  return dir;
}

describe("mintLocalSecrets", () => {
  test("a fresh clone gets the master key and every mintable secret, and nothing somebody else issues", async () => {
    projects += 1;
    const config = await configDir();
    const { dir, targets } = await clone(`mint-${projects}`);
    const paths = { env: { PITHY_CONFIG_DIR: config } };

    const report = await mintLocalSecrets({ projectDir: dir, targets, paths });

    expect(report.minted).toEqual([MASTER_KEY_BINDING, "auth-session-secret"]);
    expect(report.path).toBe(join(config, `mint-${projects}`, "secrets.jsonc"));
    expect(Object.keys(await readDevSecrets(report.path)).sort()).toEqual(
      ["SECRETS_ENCRYPTION_KEYS", "auth-session-secret"].sort(),
    );
  });

  test("a second run mints nothing and rewrites nothing", async () => {
    projects += 1;
    const config = await configDir();
    const { dir, targets } = await clone(`mint-${projects}`);
    const paths = { env: { PITHY_CONFIG_DIR: config } };
    const first = await mintLocalSecrets({ projectDir: dir, targets, paths });
    const before = await readFile(first.path, "utf8");

    const second = await mintLocalSecrets({ projectDir: dir, targets, paths });

    expect(second.minted).toEqual([]);
    expect(await readFile(first.path, "utf8")).toBe(before);
  });

  test("a second clone of the same project reuses the first clone's secrets and mints nothing", async () => {
    projects += 1;
    const config = await configDir();
    const paths = { env: { PITHY_CONFIG_DIR: config } };
    const one = await clone(`mint-${projects}`);
    const five = await clone(`mint-${projects}`);
    const first = await mintLocalSecrets({ projectDir: one.dir, targets: one.targets, paths });
    const before = await readFile(first.path, "utf8");

    const again = await mintLocalSecrets({ projectDir: five.dir, targets: five.targets, paths });

    expect(again.path).toBe(first.path);
    expect(again.minted).toEqual([]);
    expect(await readFile(first.path, "utf8")).toBe(before);
  });

  test("a dry run names what it would mint and writes no file", async () => {
    projects += 1;
    const config = await configDir();
    const { dir, targets } = await clone(`mint-${projects}`);
    const paths = { env: { PITHY_CONFIG_DIR: config } };

    const report = await mintLocalSecrets({ projectDir: dir, targets, paths, dryRun: true });

    expect(report.minted).toEqual([MASTER_KEY_BINDING, "auth-session-secret"]);
    expect(await readFile(report.path, "utf8").catch(() => null)).toBeNull();
  });

  test("a project no Worker of which composes secrets has nothing to mint", async () => {
    projects += 1;
    const config = await configDir();
    const { dir } = await clone(`mint-${projects}`);

    const report = await mintLocalSecrets({
      projectDir: dir,
      targets: [],
      paths: { env: { PITHY_CONFIG_DIR: config } },
    });

    expect(report.minted).toEqual([]);
  });

  test("pithy.config.ts is never written", async () => {
    projects += 1;
    const config = await configDir();
    const { dir, targets } = await clone(`mint-${projects}`);
    const before = await readFile(join(dir, "pithy.config.ts"), "utf8");

    await mintLocalSecrets({ projectDir: dir, targets, paths: { env: { PITHY_CONFIG_DIR: config } } });

    expect(await readFile(join(dir, "pithy.config.ts"), "utf8")).toBe(before);
  });
});
