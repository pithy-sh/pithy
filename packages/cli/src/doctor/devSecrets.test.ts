// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { devSecretsPath } from "../devSecrets/file";
import type { DevSecretsTarget } from "../devSecrets/seed";
import { checkDevSecrets, describeDevSecrets, devSecretsHealthy } from "./devSecrets";

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
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-doctor-secrets-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One Worker composing `secrets`, resolved against the per-test directory. */
function board(): DevSecretsTarget {
  return { name: "board", dir: join(dir, "apps", "board"), registry };
}

function check() {
  return checkDevSecrets({ projectDir: dir, targets: [board()] });
}

describe("checkDevSecrets", () => {
  test("a project no Worker composes secrets in has no question to answer", async () => {
    expect(await checkDevSecrets({ projectDir: dir, targets: [] })).toBeNull();
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

  test("a secret in both files is named as a duplicate, because the two can disagree silently", async () => {
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=old\n");
    await writeFile(
      devSecretsPath(dir),
      '{ "auth-session-secret": { "currentVersion": "1", "versions": { "1": "n" } } }',
    );
    const result = await check();
    expect(result?.misplaced).toEqual([{ name: "auth-session-secret", alsoStated: true }]);
  });

  test("reports the file's mode, so a world-readable secrets file is caught before it matters", async () => {
    await writeFile(devSecretsPath(dir), "{}");
    await chmod(devSecretsPath(dir), 0o644);
    expect((await check())?.mode).toBe(0o644);
  });

  test("no file is no mode, and no fault — a project has none until a capability needs one", async () => {
    const result = await check();
    expect(result?.mode).toBeNull();
    expect(result?.misplaced).toEqual([]);
  });

  test("never throws on a malformed file — a diagnostic runs in the environment it diagnoses", async () => {
    await writeFile(devSecretsPath(dir), "{ nope");
    await chmod(devSecretsPath(dir), 0o600);
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
    await writeFile(
      devSecretsPath(dir),
      '{ "gone-capability-key": { "currentVersion": "1", "versions": { "1": "x" } } }',
    );
    expect((await check())?.undeclared).toEqual(["gone-capability-key"]);
  });

  test("an undeclared name is not a fault — a stale line must not turn a green report red", async () => {
    await writeFile(
      devSecretsPath(dir),
      '{ "gone-capability-key": { "currentVersion": "1", "versions": { "1": "x" } } }',
    );
    await chmod(devSecretsPath(dir), 0o600);
    const result = await check();
    expect(result && devSecretsHealthy(result)).toBe(true);
  });

  test("a malformed file reports nothing missing — it would name every declared secret, over one fault", async () => {
    await writeFile(devSecretsPath(dir), "{ nope");
    const result = await check();
    expect(result?.unreadable).toBe(true);
    expect(result?.missing).toEqual([]);
  });
});

describe("devSecretsHealthy", () => {
  const clean = {
    path: "/p/.dev.secrets.jsonc",
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
    expect(devSecretsHealthy({ ...clean, misplaced: [{ name: "a-b", alsoStated: false }] })).toBe(false);
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
      path: "/p/.dev.secrets.jsonc",
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
      path: "/p/.dev.secrets.jsonc",
      misplaced: [{ name: "auth-session-secret", alsoStated: false }],
      missing: [],
      undeclared: [],
      mode: null,
      unreadable: false,
    });
    expect(lines.join("\n")).toContain("auth-session-secret");
    expect(lines.join("\n")).toContain(".dev.vars");
    expect(lines.join("\n")).toContain(".dev.secrets.jsonc");
  });

  test("a duplicate says which copy dev actually reads, or the fix is a coin toss", () => {
    const lines = describeDevSecrets({
      path: "/p/.dev.secrets.jsonc",
      misplaced: [{ name: "auth-session-secret", alsoStated: true }],
      missing: [],
      undeclared: [],
      mode: 0o600,
      unreadable: false,
    });
    expect(lines.join("\n")).toContain("both");
  });

  test("a mode wider than 0600 is named in the mode people write it in", () => {
    const lines = describeDevSecrets({
      path: "/p/.dev.secrets.jsonc",
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
      path: "/p/.dev.secrets.jsonc",
      misplaced: [],
      missing: [],
      undeclared: [],
      mode: 0o600,
      unreadable: true,
    });
    expect(lines.join("\n")).toMatch(/will not parse|unreadable/i);
  });
});
