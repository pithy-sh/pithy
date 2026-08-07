// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { devSecretsFile } from "../devSecrets/location";
import type { DevSecretsTarget } from "../devSecrets/seed";
import type { StatePathOptions } from "../notifier/state";
import {
  checkDevSecrets,
  checkDevSecretsLocation,
  describeDevSecrets,
  describeDevSecretsLocation,
  devSecretsHealthy,
} from "./devSecrets";

const registry = defineSecretRegistry({
  "auth-session-secret": {
    backend: "d1",
    scope: "environment",
    rotatable: true,
    valueType: "text",
    devValue: "random",
  },
  CLOUDFLARE_API_TOKEN: {
    backend: "cf-secrets-store",
    scope: "global",
    rotatable: false,
    valueType: "text",
  },
});

let dir: string;
let config: string;
/** The resolved secrets file for this test's project. Outside `dir` — that is the point of #156. */
let path: string;

/** The config seams. Fresh per test, so nothing here can read or write the operator's own file. */
function paths(): StatePathOptions {
  return { platform: "linux", homedir: "/home/nobody", env: { PITHY_CONFIG_DIR: config } };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-doctor-secrets-"));
  config = await mkdtemp(join(tmpdir(), "pithy-doctor-config-"));
  // The check resolves the file from the project's name, so the project needs a `pithy.config.ts`.
  await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "clinic" };\n');
  path = devSecretsFile("clinic", paths());
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

/** One Worker composing `secrets`, resolved against the per-test directory. */
function board(): DevSecretsTarget {
  return { name: "board", dir: join(dir, "apps", "board"), registry };
}

function check() {
  return checkDevSecrets({ projectDir: dir, targets: [board()], paths: paths() });
}

describe("checkDevSecrets", () => {
  test("a project no Worker composes secrets in has no question to answer", async () => {
    expect(await checkDevSecrets({ projectDir: dir, targets: [], paths: paths() })).toBeNull();
  });

  test("names a d1-backed secret found in .dev.vars — this is the whole migration notice", async () => {
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_ACCOUNT_ID=abc\nauth-session-secret=old\n");
    const result = await check();
    expect(result?.misplaced.map((m) => m.name)).toEqual(["auth-session-secret"]);
  });

  test("an env binding in .dev.vars is not misplaced — that is the file it belongs in", async () => {
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_ACCOUNT_ID=abc\nSECRETS_ENCRYPTION_KEYS={}\n");
    expect((await check())?.misplaced).toEqual([]);
  });

  test("a cf-secrets-store secret in .dev.vars is where it belongs — there is no local store", async () => {
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_API_TOKEN=tok\n");
    expect((await check())?.misplaced).toEqual([]);
  });

  test("pithy's own injected copy is the transition, not a fault", async () => {
    // The CLI writes this line itself, every `pithy dev`, because dev resolves every secret from its
    // binding whatever its backend (#153). Doctor told every project on this branch to delete the one
    // line that keeps dev working — the branch and the diagnostic disagreeing about the same file.
    await writeFile(path, '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "n" } } }');
    await chmod(path, 0o600);
    await writeFile(join(dir, ".dev.vars"), `auth-session-secret={"currentVersion":"1","versions":{"1":"n"}}\n`);

    const result = await check();

    expect(result?.misplaced).toEqual([{ name: "auth-session-secret", state: "injected" }]);
    expect(devSecretsHealthy(result as NonNullable<typeof result>)).toBe(true);
  });

  test("a copy that disagrees with the file is stale, and the seeder is what fixes it", async () => {
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=old\n");
    await writeFile(path, '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "n" } } }');
    const result = await check();
    expect(result?.misplaced).toEqual([{ name: "auth-session-secret", state: "stale" }]);
  });

  test("a secret only in .dev.vars is the migration case, and is still named as one", async () => {
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=old\n");
    const result = await check();
    expect(result?.misplaced).toEqual([{ name: "auth-session-secret", state: "unmoved" }]);
  });

  test("reports the file's mode, so a world-readable secrets file is caught before it matters", async () => {
    await writeFile(path, "{}");
    await chmod(path, 0o644);
    expect((await check())?.mode).toBe(0o644);
  });

  test("no file is no mode, and no fault — a project has none until a capability needs one", async () => {
    const result = await check();
    expect(result?.mode).toBeNull();
    expect(result?.misplaced).toEqual([]);
  });

  test("never throws on a malformed file — a diagnostic runs in the environment it diagnoses", async () => {
    await writeFile(path, "{ nope");
    await chmod(path, 0o600);
    const result = await check();
    expect(result?.unreadable).toBe(true);
  });

  test("a secret nothing can mint, with no value anywhere, is listed once here instead of on every run", async () => {
    // CLOUDFLARE_API_TOKEN is Cloudflare's to issue. `auth-session-secret` is not listed: it is
    // `devValue: "random"`, so the next seed supplies it and there is nothing for anyone to do.
    expect((await check())?.missing).toEqual(["CLOUDFLARE_API_TOKEN"]);
  });

  test("a value in either file is not missing — the file is dev's source of truth, .dev.vars still resolves", async () => {
    await writeFile(join(dir, ".dev.vars"), "CLOUDFLARE_API_TOKEN=tok\n");
    expect((await check())?.missing).toEqual([]);
  });

  test("a name no capability declares is reported here, where the config is loaded fresh", async () => {
    await writeFile(path, '{ "gone-capability-key": { "currentVersion": "1", "versions": { "1": "x" } } }');
    expect((await check())?.undeclared).toEqual(["gone-capability-key"]);
  });

  test("an undeclared name is not a fault — a stale line must not turn a green report red", async () => {
    await writeFile(path, '{ "gone-capability-key": { "currentVersion": "1", "versions": { "1": "x" } } }');
    await chmod(path, 0o600);
    const result = await check();
    expect(result && devSecretsHealthy(result)).toBe(true);
  });

  test("a malformed file reports nothing missing — it would name every declared secret, over one fault", async () => {
    await writeFile(path, "{ nope");
    const result = await check();
    expect(result?.unreadable).toBe(true);
    expect(result?.missing).toEqual([]);
  });

  test("a malformed file reports nothing misplaced either — it cannot tell pithy's own copy from theirs", async () => {
    // The classification compares the `.dev.vars` copy against the file. A file that will not parse
    // states nothing, so pithy's own injected line — the one thing nobody should touch before #153 —
    // fell through to `unmoved`, and doctor told the adopter to go move it. A broken file is its own
    // diagnosis; every other sentence it produces is a guess.
    await writeFile(join(dir, ".dev.vars"), `auth-session-secret={"currentVersion":"1","versions":{"1":"n"}}\n`);
    await writeFile(path, "{ nope");

    const result = await check();

    expect(result?.unreadable).toBe(true);
    expect(result?.misplaced).toEqual([]);
    expect(describeDevSecrets(result as NonNullable<typeof result>).join("\n")).not.toContain("belongs in");
  });
});

describe("devSecretsHealthy", () => {
  const clean = {
    path: "/home/u/.config/pithy/acme/secrets.jsonc",
    misplaced: [],
    missing: [],
    undeclared: [],
    mode: 0o600,
    unreadable: false,
  };

  test("a missing secret is not a fault — four unset OAuth pairs must not drag every report verbose", () => {
    expect(devSecretsHealthy({ ...clean, missing: ["auth-google-credentials"] })).toBe(true);
  });

  test("a misplaced secret, a wide mode, and a broken file each are", () => {
    expect(devSecretsHealthy({ ...clean, misplaced: [{ name: "a-b", state: "unmoved" }] })).toBe(false);
    expect(devSecretsHealthy({ ...clean, misplaced: [{ name: "a-b", state: "stale" }] })).toBe(false);
    expect(devSecretsHealthy({ ...clean, mode: 0o644 })).toBe(false);
    expect(devSecretsHealthy({ ...clean, unreadable: true })).toBe(false);
  });

  test("no file at all is healthy — a project has none until a capability needs one", () => {
    expect(devSecretsHealthy({ ...clean, mode: null })).toBe(true);
  });
});

describe("describeDevSecrets", () => {
  test("a healthy project says one line and asks nothing", () => {
    const lines = describeDevSecrets({
      path: "/home/u/.config/pithy/acme/secrets.jsonc",
      misplaced: [],
      missing: [],
      undeclared: [],
      mode: 0o600,
      unreadable: false,
    });
    expect(lines).toEqual([]);
  });

  test("a misplaced secret is told where it belongs and that nothing was moved for them", () => {
    const lines = describeDevSecrets({
      path: "/home/u/.config/pithy/acme/secrets.jsonc",
      misplaced: [{ name: "auth-session-secret", state: "unmoved" }],
      missing: [],
      undeclared: [],
      mode: null,
      unreadable: false,
    });
    expect(lines.join("\n")).toContain("auth-session-secret");
    expect(lines.join("\n")).toContain(".dev.vars");
    expect(lines.join("\n")).toContain("/home/u/.config/pithy/acme/secrets.jsonc");
  });

  test("a stale copy names the command that rewrites it, rather than telling anyone to delete it", () => {
    const lines = describeDevSecrets({
      path: "/home/u/.config/pithy/acme/secrets.jsonc",
      misplaced: [{ name: "auth-session-secret", state: "stale" }],
      missing: [],
      undeclared: [],
      mode: 0o600,
      unreadable: false,
    });
    expect(lines.join("\n")).toContain("pithy seed");
  });

  test("the injected copy is explained, and nobody is told to delete it", () => {
    // Deleting it is the one action that breaks dev before #153 lands.
    const lines = describeDevSecrets({
      path: "/home/u/.config/pithy/acme/secrets.jsonc",
      misplaced: [{ name: "auth-session-secret", state: "injected" }],
      missing: [],
      undeclared: [],
      mode: 0o600,
      unreadable: false,
    });
    expect(lines.join("\n")).toContain("auth-session-secret");
    expect(lines.join("\n")).not.toContain("Delete");
    expect(lines.join("\n")).not.toContain("belongs in");
  });

  test("a mode wider than 0600 is named in the mode people write it in", () => {
    const lines = describeDevSecrets({
      path: "/home/u/.config/pithy/acme/secrets.jsonc",
      misplaced: [],
      missing: [],
      undeclared: [],
      mode: 0o644,
      unreadable: false,
    });
    expect(lines.join("\n")).toContain("644");
    expect(lines.join("\n")).toContain("600");
  });

  test("an unreadable file says so rather than reporting a clean project", () => {
    const lines = describeDevSecrets({
      path: "/home/u/.config/pithy/acme/secrets.jsonc",
      misplaced: [],
      missing: [],
      undeclared: [],
      mode: 0o600,
      unreadable: true,
    });
    expect(lines.join("\n")).toMatch(/will not parse|unreadable/i);
  });
});

describe("checkDevSecretsLocation", () => {
  test("reports the resolved path even when there is no file — nothing else in the run names it", async () => {
    // Not a fault, and that is why it is a separate check: the path is the answer to "where do my dev
    // secrets go", and since #156 there is no file in the checkout to find it by.
    const check = await checkDevSecretsLocation(dir, paths());
    expect(check).toEqual({ path, present: false, orphans: [] });
    expect(describeDevSecretsLocation(check as NonNullable<typeof check>)).toContain("no file yet");
  });

  test("a file that is there needs no sentence — the path is the whole answer", async () => {
    await writeFile(path, "{}\n");
    const check = await checkDevSecretsLocation(dir, paths());
    expect(check).toEqual({ path, present: true, orphans: [] });
    expect(describeDevSecretsLocation(check as NonNullable<typeof check>)).toBeNull();
  });

  test("a project with no file names the directories that do have one — a rename leaves a trail", async () => {
    // The directory is keyed on the project's `name`, so renaming a project silently changes which
    // file every command reads and leaves the old one behind with every value in it. Nothing else
    // could ever mention it: the old name is in no file this checkout still has.
    await mkdir(join(config, "clinic-old"), { recursive: true, mode: 0o700 });
    await writeFile(join(config, "clinic-old", "secrets.jsonc"), "{}\n");
    await mkdir(join(config, "no-secrets-here"), { recursive: true, mode: 0o700 });

    const check = await checkDevSecretsLocation(dir, paths());

    expect(check?.orphans).toEqual(["clinic-old"]);
    expect(describeDevSecretsLocation(check as NonNullable<typeof check>)).toContain("clinic-old");
  });

  test("a project that has its own file hears about nobody else's", async () => {
    // A machine with six projects on it must not hear about five of them on every run. The list is
    // for the one shape it diagnoses — this project has no file, and one of those is probably why.
    await mkdir(join(config, "clinic-old"), { recursive: true, mode: 0o700 });
    await writeFile(join(config, "clinic-old", "secrets.jsonc"), "{}\n");
    await writeFile(path, "{}\n");

    expect((await checkDevSecretsLocation(dir, paths()))?.orphans).toEqual([]);
  });

  test("no project name is no question — it declines rather than guessing a directory", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "export default {};\n");
    expect(await checkDevSecretsLocation(dir, paths())).toBeNull();
  });
});
