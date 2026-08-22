// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StatePathOptions } from "../notifier/state";
import {
  DEV_SECRETS_FILE_NAME,
  devSecretsDir,
  devSecretsFile,
  ensureDevSecretsDir,
  resolveDevSecretsFile,
} from "./location";

let dir: string;
let config: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-secrets-loc-"));
  config = await mkdtemp(join(tmpdir(), "pithy-secrets-cfg-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

/** The seams, as a function: `config` is fresh per test, so a captured const would go stale. */
function options(): StatePathOptions {
  return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: config } };
}

/** A root `pithy.config.ts` naming this project — the only file the resolver needs. */
async function project(name: string): Promise<void> {
  await writeFile(join(dir, "pithy.config.ts"), `export default { name: ${JSON.stringify(name)} };\n`);
}

describe("devSecretsFile", () => {
  test("is <config>/<project>/secrets.jsonc, the same neighborhood dev.json already lives in", () => {
    expect(devSecretsFile("replay", options())).toBe(join(config, "replay", DEV_SECRETS_FILE_NAME));
    expect(devSecretsDir("replay", options())).toBe(join(config, "replay"));
  });

  test("a name that is not a valid project name is refused, naming the value (#212)", () => {
    // Safe today — every caller has been through `requireProjectName` or `kebab`. The rule now lives at
    // the join instead of at each of them, because this directory holds every dev secret a project has
    // and `ensureScaffoldPath` guards writes *inside a project*, which this path is outside of.
    for (const name of ["../evil", "a/b", "..", "", "Acme Corp"]) {
      const thrown = (() => {
        try {
          devSecretsDir(name, options());
        } catch (error) {
          return error as PithyError;
        }
        return null;
      })();
      expect(thrown, JSON.stringify(name)).toBeInstanceOf(PithyError);
    }
    // And the file below it, which is the same join one segment further down.
    expect(() => devSecretsFile("../evil", options())).toThrow(PithyError);
  });

  test("follows the platform resolver rather than a second one — no PITHY_CONFIG_DIR, no home guess", () => {
    // The whole point of reusing #131's `stateDir`: two answers to "where does config live" is the
    // defect this move exists to remove, not one to reproduce one directory over.
    const posix = { platform: "linux" as const, homedir: "/home/u", env: {} };
    expect(devSecretsFile("replay", posix)).toBe("/home/u/.config/pithy/replay/secrets.jsonc");
    const xdg = { platform: "linux" as const, homedir: "/home/u", env: { XDG_CONFIG_HOME: "/cfg" } };
    expect(devSecretsFile("replay", xdg)).toBe("/cfg/pithy/replay/secrets.jsonc");
  });
});

describe("resolveDevSecretsFile", () => {
  test("keys on the project name, not the checkout — every worktree of one project resolves one file", async () => {
    await project("replay");
    const one = await resolveDevSecretsFile(dir, options());

    // A second checkout of the same project: different directory, same name, same file.
    const other = await mkdtemp(join(tmpdir(), "pithy-secrets-wt-"));
    await writeFile(join(other, "pithy.config.ts"), 'export default { name: "replay" };\n');
    try {
      expect(await resolveDevSecretsFile(other, options())).toBe(one);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  test("a project with no name refuses by name, and says which file it could not place", async () => {
    // `requireProjectName` is the same gate every resource name goes through. A guessed name here would
    // key a project's secrets on its directory basename, and a worktree would get a different set.
    await writeFile(join(dir, "pithy.config.ts"), "export default {};\n");
    const error = await resolveDevSecretsFile(dir, options()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PithyError);
    expect((error as PithyError).payload.message).toContain("name");
  });
});

describe("ensureDevSecretsDir", () => {
  test("creates the project directory 0700 — it holds nothing but plaintext credentials", async () => {
    const path = devSecretsFile("replay", options());
    await ensureDevSecretsDir(path);
    expect((await stat(join(config, "replay"))).mode & 0o777).toBe(0o700);
  });

  test("narrows a directory somebody else left at 0755, on every call and not only the first", async () => {
    // The umask is not a permission policy, and a directory created by an older pithy, a `cp -r`, or a
    // restore keeps its mode forever otherwise — while listing every secret name this project has.
    const path = devSecretsFile("replay", options());
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o755 });
    await ensureDevSecretsDir(path);
    expect((await stat(join(config, "replay"))).mode & 0o777).toBe(0o700);
  });
});
