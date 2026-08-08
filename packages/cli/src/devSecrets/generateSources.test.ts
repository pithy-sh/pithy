// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDevVars } from "@pithy-sh/cloudflare/src/env/devVars";
import type { EncryptionConfig } from "@pithy-sh/secrets/src/crypto/envelope";
import { initialMasterKeyConfig } from "@pithy-sh/secrets/src/provision/provisionSecrets";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StatePathOptions } from "../notifier/state";
import { writeBootstrapVars } from "./bootstrapVars";
import { writeDevSecrets } from "./file";
import { generateDevVars } from "./generate";
import { devSecretsFile } from "./location";

/**
 * #179, end to end: **`secrets.jsonc` is the single source of dev secret values.**
 *
 * The generator used to read a *copy* — `pithy seed` routed every `cf-secrets-store` value into
 * `<config>/<project>/dev.json` under `vars`, and generation read that. So rotating a value in the file
 * named "the dev secrets file" did not reach a Worker until something re-seeded, and deleting one left
 * its plaintext in `dev.json` forever, still rendered into every generated `.dev.vars`.
 *
 * These cases are written against a **real composition**, because the registry is what decides which
 * names are materialised at all — a fixture with a fake registry would prove nothing about the file a
 * Worker actually receives. That means scaffolding inside the package, where `pithy.config.ts`'s
 * `@pithy-sh/*` imports resolve against the workspace node_modules and vitest will transform the config;
 * the same reason `targets.test.ts` does it.
 *
 * The project's **name** and its first Worker's **directory name** are deliberately different — `replay`
 * and `board`. A fixture where the two match hides a whole class of path bug.
 */

let dir: string;
let config: string;

beforeEach(async () => {
  dir = await mkdtemp(join(import.meta.dirname, "..", "..", ".e2e-gensrc-"));
  config = await mkdtemp(join(tmpdir(), "pithy-gensrc-cfg-"));
  await writeFile(join(dir, "pithy.config.ts"), "export default { name: 'replay' };\n");
  await worker("board");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

/** The config-directory seam. Never the real one: that directory holds live dev credentials. */
function paths(): StatePathOptions {
  return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: config } };
}

/** What `pithy add secrets` writes, plus a capability whose own registry declares a second secret. */
const COMPOSITION = `
import { email } from "@pithy-sh/email/src/index";
import { secrets } from "@pithy-sh/secrets/src/index";

export default {
  capabilities: [
    secrets({ rotationIntervalDays: 30 }),
    email({ fromAddress: "noreply@example.com", fromName: "Replay", baseUrl: "https://board.example.com" }),
  ],
};
`;

async function worker(name: string): Promise<string> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify({ name: `replay-${name}` }));
  await writeFile(join(workerDir, "pithy.config.ts"), COMPOSITION);
  return workerDir;
}

/** The generated file for one Worker, parsed the way pithy's own readers parse it. */
async function generated(name = "board"): Promise<Record<string, string>> {
  return parseDevVars(await readFile(join(dir, "apps", name, ".dev.vars"), "utf8"));
}

/** State a master key in `secrets.jsonc` — the shape `pithy add secrets` writes. */
async function stateMasterKey(): Promise<EncryptionConfig> {
  const value = await initialMasterKeyConfig();
  await writeDevSecrets(devSecretsFile("replay", paths()), {
    SECRETS_ENCRYPTION_KEYS: { currentVersion: "1", versions: { "1": value } },
  });
  return value;
}

describe("the generated .dev.vars is built from secrets.jsonc", () => {
  test("a cf-secrets-store secret reaches the Worker with no seeding run in between", async () => {
    const key = await stateMasterKey();

    await generateDevVars({ projectDir: dir, paths: paths() });

    // The master key is a registry secret with `bootstrap: true`, so its binding carries the
    // `EncryptionConfig` itself — which is what `resolveEncryptionConfig` parses, in dev and deployed.
    expect(JSON.parse((await generated()).SECRETS_ENCRYPTION_KEYS ?? "null")).toEqual(key);
  });

  test("editing the value in secrets.jsonc changes the binding on the next generation", async () => {
    await stateMasterKey();
    await generateDevVars({ projectDir: dir, paths: paths() });
    const before = (await generated()).SECRETS_ENCRYPTION_KEYS;

    // The rotation an adopter performs: edit the file, run `pithy dev`. Nothing re-seeds in between.
    const rotated = await initialMasterKeyConfig();
    await writeDevSecrets(
      devSecretsFile("replay", paths()),
      { SECRETS_ENCRYPTION_KEYS: { currentVersion: "1", versions: { "1": rotated } } },
      { replace: true },
    );
    await generateDevVars({ projectDir: dir, paths: paths() });

    expect((await generated()).SECRETS_ENCRYPTION_KEYS).not.toBe(before);
    expect(JSON.parse((await generated()).SECRETS_ENCRYPTION_KEYS ?? "null")).toEqual(rotated);
  });

  test("removing it from secrets.jsonc removes it from every generated file", async () => {
    await stateMasterKey();
    await worker("api");
    await generateDevVars({ projectDir: dir, paths: paths() });
    expect((await generated("api")).SECRETS_ENCRYPTION_KEYS).toBeDefined();

    await writeFile(devSecretsFile("replay", paths()), "{}\n");
    await generateDevVars({ projectDir: dir, paths: paths() });

    expect((await generated()).SECRETS_ENCRYPTION_KEYS).toBeUndefined();
    expect((await generated("api")).SECRETS_ENCRYPTION_KEYS).toBeUndefined();
  });

  test("a stale copy in dev.json cannot resurrect a removed secret", async () => {
    // The exact residue the old design left behind: `bootstrapVars` said "A value is never removed
    // here", so a deleted secret's plaintext stayed in `dev.json` and kept being rendered. A name the
    // registry declares is now that file's to answer and `dev.json` is not consulted for it at all.
    await writeBootstrapVars(dir, { SECRETS_ENCRYPTION_KEYS: "a-stale-copy" }, paths());

    await generateDevVars({ projectDir: dir, paths: paths() });

    expect((await generated()).SECRETS_ENCRYPTION_KEYS).toBeUndefined();
  });

  test("dev.json still supplies a value no registry declares — a Turnstile sitekey has no other home", async () => {
    await writeBootstrapVars(dir, { TURNSTILE_SITEKEY: "0x4AAA" }, paths());

    await generateDevVars({ projectDir: dir, paths: paths() });

    expect((await generated()).TURNSTILE_SITEKEY).toBe("0x4AAA");
  });

  test("the header names the two files that are actually read", async () => {
    await generateDevVars({ projectDir: dir, paths: paths() });
    const body = await readFile(join(dir, "apps", "board", ".dev.vars"), "utf8");

    expect(body).toContain("the dev secrets file and this machine's dev.json");
  });
});
