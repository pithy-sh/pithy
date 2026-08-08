// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { StatePathOptions } from "../notifier/state";
import { bootstrapVarsPath, readBootstrapVars, removeBootstrapVars, writeBootstrapVars } from "./bootstrapVars";

let dir: string;
let config: string;

function paths(): StatePathOptions {
  return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: config } };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-bootstrap-"));
  config = await mkdtemp(join(tmpdir(), "pithy-bootstrap-config-"));
  await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "replay" };\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

describe("bootstrapVars", () => {
  test("it is dev.json's second tenant, not a second file beside it", async () => {
    // #131 already established `<config>/<project>/dev.json`. Inventing another location for "the
    // machine's dev values" would be a third convention for the same directory.
    expect(await bootstrapVarsPath(dir, paths())).toBe(join(config, "replay", "dev.json"));
  });

  test("a value written is a value read back", async () => {
    await writeBootstrapVars(dir, { SECRETS_ENCRYPTION_KEYS: "k" }, paths());
    expect(await readBootstrapVars(dir, paths())).toEqual({ SECRETS_ENCRYPTION_KEYS: "k" });
  });

  test("another tenant's key survives a write — the file is shared", async () => {
    // A dev-login preference sitting beside this set must not be deleted by a `pithy add secrets`.
    const path = join(config, "replay", "dev.json");
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ devLogin: { email: "me@example.com" } }));

    await writeBootstrapVars(dir, { K: "v" }, paths());

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      devLogin: { email: "me@example.com" },
      vars: { K: "v" },
    });
  });

  test("the file is 0600 and its directory 0700 — the dev master key is in it", async () => {
    await writeBootstrapVars(dir, { SECRETS_ENCRYPTION_KEYS: "k" }, paths());
    expect((await stat(join(config, "replay", "dev.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(config, "replay"))).mode & 0o777).toBe(0o700);
  });

  test("a file left world-readable by something else is narrowed on the next write", async () => {
    const path = join(config, "replay", "dev.json");
    await writeBootstrapVars(dir, { K: "v" }, paths());
    await chmod(path, 0o644);
    await writeBootstrapVars(dir, { K: "w" }, paths());
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a present file that will not open refuses rather than being replaced", async () => {
    // Read-modify-write over a file with other tenants. `catch(() => ({}))` would silently delete a
    // developer's dev-login preference — the same shape that lost a `.dev.vars` twice.
    const path = join(config, "replay", "dev.json");
    await writeBootstrapVars(dir, { K: "v" }, paths());
    await chmod(path, 0o000);
    try {
      await expect(writeBootstrapVars(dir, { K: "w" }, paths())).rejects.toThrow(/could not read/);
    } finally {
      await chmod(path, 0o600);
    }
    expect(await readBootstrapVars(dir, paths())).toEqual({ K: "v" });
  });

  test("a hand-edited file that will not parse reads as empty rather than stopping pithy dev", async () => {
    // The reader is not about to rewrite anything, so "absent" licenses nothing here. A half-typed
    // preference must not stop every Worker from starting; the Worker's own missing-binding error is the
    // louder, more accurate message anyway.
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(join(config, "replay", "dev.json"), "{ not json");
    expect(await readBootstrapVars(dir, paths())).toEqual({});
  });

  test("a non-string value is not carried into a binding", async () => {
    // It would reach the encoder as an object and be written as `[object Object]`.
    await mkdir(join(config, "replay"), { recursive: true, mode: 0o700 });
    await writeFile(join(config, "replay", "dev.json"), JSON.stringify({ vars: { K: 7 } }));
    expect(await readBootstrapVars(dir, paths())).toEqual({});
  });

  test("removal takes the name out, and a name that is not there is a no-op", async () => {
    await writeBootstrapVars(dir, { KEEP: "1", GO: "2" }, paths());
    expect(await removeBootstrapVars(dir, ["GO", "NEVER_THERE"], paths())).toEqual({ KEEP: "1" });
    expect(await readBootstrapVars(dir, paths())).toEqual({ KEEP: "1" });
  });

  test("a project with no name has nothing to key on and writes nothing", async () => {
    await rm(join(dir, "pithy.config.ts"));
    expect(await bootstrapVarsPath(dir, paths())).toBeNull();
    expect(await writeBootstrapVars(dir, { K: "v" }, paths())).toEqual({});
    expect(await readBootstrapVars(dir, paths())).toEqual({});
  });

  test("writing nothing creates no file", async () => {
    await writeBootstrapVars(dir, {}, paths());
    await expect(stat(join(config, "replay", "dev.json"))).rejects.toThrow();
  });
});
