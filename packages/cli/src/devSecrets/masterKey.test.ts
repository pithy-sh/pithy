// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptionConfig } from "@pithy-sh/secrets/src/crypto/envelope";
import { MASTER_KEY_BINDING } from "@pithy-sh/secrets/src/env/masterKeyBinding";
import { afterEach, describe, expect, test } from "vitest";
import { removeTempDir } from "../test-utils/tempRepo";
import { readDevSecrets } from "./file";
import { settleDevMasterKey } from "./masterKey";

/**
 * **`settleDevMasterKey` is the one decision `pithy add secrets` and `pithy setup` both make (#764).** A key the
 * file states is kept, a key an older home holds is carried over, and only a machine with neither gets a fresh
 * one — because a second key orphans every secret the first one encrypted.
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

let projects = 0;
/** A project with a name of its own and a config directory of its own. */
async function project(): Promise<{ dir: string; paths: { env: NodeJS.ProcessEnv }; configDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-master-key-"));
  dirs.push(dir);
  projects += 1;
  await writeFile(join(dir, "pithy.config.ts"), `export default { name: "master-key-${projects}" };\n`);
  const configDir = join(dir, ".config");
  return { dir, paths: { env: { PITHY_CONFIG_DIR: configDir } }, configDir };
}

async function stated(dir: string, paths: { env: NodeJS.ProcessEnv }): Promise<unknown> {
  const { resolveDevSecretsFile } = await import("./location");
  return (await readDevSecrets(await resolveDevSecretsFile(dir, paths)))[MASTER_KEY_BINDING];
}

describe("settleDevMasterKey", () => {
  test("a machine with no key gets a fresh one, written into the dev secrets file", async () => {
    const { dir, paths, configDir } = await project();

    const outcome = await settleDevMasterKey(dir, { paths });

    expect(outcome.state).toBe("minted");
    expect(EncryptionConfig.safeParse(await stated(dir, paths)).success).toBe(true);
    expect(outcome.path).toBe(join(configDir, `master-key-${projects}`, "secrets.jsonc"));
  });

  test("a second run keeps the key it found, byte for byte", async () => {
    const { dir, paths } = await project();
    const first = await settleDevMasterKey(dir, { paths });
    const before = await readFile(first.path, "utf8");

    const second = await settleDevMasterKey(dir, { paths });

    expect(second.state).toBe("present");
    expect(await readFile(first.path, "utf8")).toBe(before);
  });

  test("a key in the project's old .dev.vars is carried over, never re-minted", async () => {
    const { dir, paths } = await project();
    const key = {
      currentVersion: "1",
      versions: { "1": Buffer.alloc(32, 7).toString("base64") },
      lastRotatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(EncryptionConfig.safeParse(key).success).toBe(true);
    await writeFile(join(dir, ".dev.vars"), `${MASTER_KEY_BINDING}='${JSON.stringify(key)}'\n`);

    const outcome = await settleDevMasterKey(dir, { paths });

    expect(outcome.state).toBe("adopted");
    expect(await stated(dir, paths)).toEqual(key);
  });

  test("a value in an old home that is not a key is neither adopted nor replaced", async () => {
    const { dir, paths } = await project();
    await writeFile(join(dir, ".dev.vars"), `${MASTER_KEY_BINDING}=not-a-key\n`);

    const outcome = await settleDevMasterKey(dir, { paths });

    expect(outcome.state).toBe("invalid");
    expect(await stated(dir, paths)).toBeUndefined();
  });

  test("a dry run answers what a real run would do, and writes nothing", async () => {
    const { dir, paths } = await project();

    const outcome = await settleDevMasterKey(dir, { paths, dryRun: true });

    expect(outcome.state).toBe("minted");
    expect(await stated(dir, paths)).toBeUndefined();
  });
});
