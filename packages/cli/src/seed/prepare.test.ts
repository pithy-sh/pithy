// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { SEED_ARTIFACT_DIR } from "@pithy-sh/core/src/seed/devLogin";
import { defineSecretRegistry } from "@pithy-sh/secrets/src/registry";
import { describe, expect, test } from "vitest";
import { devSecretsFile } from "../devSecrets/location";
import { type StatePathOptions, stateDir } from "../notifier/state";
import { devPreferencesPath, devSecretReader, readDevPreferences, writeSeedArtifact } from "./prepare";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pithy-prepare-"));
}

describe("devPreferencesPath", () => {
  test("nests the project under the Pithy config directory, never directly under the config root", () => {
    expect(devPreferencesPath("acme", { platform: "linux", homedir: "/home/dev", env: {} })).toBe(
      "/home/dev/.config/pithy/acme/dev.json",
    );
  });

  test("respects XDG_CONFIG_HOME", () => {
    expect(
      devPreferencesPath("acme", { platform: "linux", homedir: "/home/dev", env: { XDG_CONFIG_HOME: "/xdg" } }),
    ).toBe("/xdg/pithy/acme/dev.json");
  });

  test("ignores an empty XDG_CONFIG_HOME rather than resolving against nothing", () => {
    expect(devPreferencesPath("acme", { platform: "linux", homedir: "/home/dev", env: { XDG_CONFIG_HOME: "" } })).toBe(
      "/home/dev/.config/pithy/acme/dev.json",
    );
  });

  // Asserted here rather than left to the delegation: this is the branch that did not exist, so a Windows
  // developer's file landed where nothing reads it. A test that only checked POSIX would have passed then too.
  test("puts a Windows developer's file under %APPDATA%", () => {
    expect(
      devPreferencesPath("acme", {
        platform: "win32",
        homedir: "C:\\Users\\u",
        env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      }),
    ).toBe(join("C:\\Users\\u\\AppData\\Roaming", "pithy", "acme", "dev.json"));
  });

  test("resolves under the same root `pithy doctor` reports, on every platform", () => {
    for (const options of [
      { platform: "linux" as const, homedir: "/home/dev", env: {} },
      { platform: "darwin" as const, homedir: "/Users/dev", env: { XDG_CONFIG_HOME: "/xdg" } },
      { platform: "win32" as const, homedir: "C:\\Users\\u", env: { APPDATA: "C:\\AppData" } },
    ]) {
      expect(devPreferencesPath("acme", options)).toBe(join(stateDir(options), "acme", "dev.json"));
    }
  });

  test("a name that is not a valid project name is refused, naming the value (#212)", () => {
    // The other joiner of the same directory, held to the same rule and by the same function — the rule
    // is `projectConfigDir`'s, not a second copy stated here. `Acme Corp` is the two-path case: legal as
    // a project *name* because it kebabs to `acme-corp`, and not the string that may become a segment.
    const options = { platform: "linux" as const, homedir: "/home/dev", env: {} };
    for (const name of ["../evil", "a/b", "..", "", "Acme Corp"]) {
      expect(() => devPreferencesPath(name, options), JSON.stringify(name)).toThrow(PithyError);
    }
  });
});

describe("readDevPreferences", () => {
  test("is undefined when the developer has not opted in", async () => {
    const home = await tempDir();
    expect(await readDevPreferences("acme", { env: { XDG_CONFIG_HOME: home }, platform: "linux" })).toBeUndefined();
  });

  test("reads the file the developer wrote", async () => {
    const home = await tempDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "pithy", "acme"), { recursive: true });
    await writeFile(join(home, "pithy", "acme", "dev.json"), '{ "user": "ada@example.com" }');
    expect(await readDevPreferences("acme", { env: { XDG_CONFIG_HOME: home }, platform: "linux" })).toEqual({
      user: "ada@example.com",
    });
  });

  test("treats an unparseable file as absent — a half-typed preference never fails a seed", async () => {
    const home = await tempDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "pithy", "acme"), { recursive: true });
    await writeFile(join(home, "pithy", "acme", "dev.json"), "{ not json");
    expect(await readDevPreferences("acme", { env: { XDG_CONFIG_HOME: home }, platform: "linux" })).toBeUndefined();
  });
});

describe("devSecretReader", () => {
  /**
   * A registry with one secret per backend, because the reader's answer must not depend on which.
   * `.dev.vars` is a generated destination since #153 and #154, not a second source — so a
   * `cf-secrets-store` value is stated in the same file as a `d1` one, and read from it.
   */
  const registry = defineSecretRegistry({
    "auth-session-secret": { backend: "d1", scope: "environment", rotatable: true, valueType: "text" },
    "app-vendor-token": { backend: "cf-secrets-store", scope: "environment", rotatable: false, valueType: "text" },
    "app-connection-keys": { backend: "d1", scope: "environment", rotatable: false, valueType: "text", keyed: true },
  });

  /** A project directory under a throwaway config root, plus the secrets file path it resolves to. */
  async function project(secrets?: unknown): Promise<{ paths: StatePathOptions; path: string }> {
    const config = await tempDir();
    const paths: StatePathOptions = { env: { PITHY_CONFIG_DIR: config }, platform: "linux" };
    const path = devSecretsFile("acme", paths);
    if (secrets !== undefined) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(secrets));
    }
    return { paths, path };
  }

  /** The envelope every value in the file wears — always full, never a bare string. */
  function envelope(value: unknown): unknown {
    return { currentVersion: "1", versions: { "1": value } };
  }

  test("resolves a secret from the dev secrets file — the source pithy seed writes", async () => {
    const { paths } = await project({ "auth-session-secret": envelope("s3cr3t") });
    const read = devSecretReader({ project: "acme", env: "dev", registry, paths });
    expect(await read("auth-session-secret")).toBe("s3cr3t");
  });

  test("resolves a cf-secrets-store secret from the same file, not from a .dev.vars", async () => {
    // The one backend with no local store still has its dev value *stated* in this file — the
    // `.dev.vars` line is generated from it, per Worker (#154). Reading the line back would read a
    // copy, and a run-wide reader cannot say which Worker's copy it should be.
    const { paths } = await project({ "app-vendor-token": envelope("vendor-token") });
    const read = devSecretReader({ project: "acme", env: "dev", registry, paths });
    expect(await read("app-vendor-token")).toBe("vendor-token");
  });

  test("is undefined for a name the file does not carry, and when there is no file at all", async () => {
    const { paths } = await project();
    expect(
      await devSecretReader({ project: "acme", env: "dev", registry, paths })("auth-session-secret"),
    ).toBeUndefined();

    const other = await project({ "app-vendor-token": envelope("vendor-token") });
    const read = devSecretReader({ project: "acme", env: "dev", registry, paths: other.paths });
    expect(await read("auth-session-secret")).toBeUndefined();
  });

  test("answers undefined for a name no registry declares — the Worker could not resolve it either", async () => {
    // The file is allowed to carry a stale name: a removed capability must not brick dev, and
    // `pithy doctor` reports it. What it must not do is become a value a prepared set acts on.
    const { paths } = await project({ "gone-away": envelope("stale") });
    expect(await devSecretReader({ project: "acme", env: "dev", registry, paths })("gone-away")).toBeUndefined();
  });

  test("answers undefined for a keyspace, which has no single value to read", async () => {
    const { paths } = await project({ "app-connection-keys": envelope("nope") });
    const read = devSecretReader({ project: "acme", env: "dev", registry, paths });
    expect(await read("app-connection-keys")).toBeUndefined();
  });

  test("never reaches Object.prototype for a secret named like one of its members", async () => {
    const { paths } = await project({});
    const read = devSecretReader({ project: "acme", env: "dev", registry, paths });
    expect(await read("constructor")).toBeUndefined();
    expect(await read("toString")).toBeUndefined();
  });

  test("refuses a value the registry says is the wrong shape, naming the secret and not the value", async () => {
    // The registry is what makes this a string. Without it a hand-edited `1234` becomes "1234" and the
    // prepared set signs with a value nobody wrote — the smell a raw read cannot see.
    const { paths } = await project({ "auth-session-secret": envelope(1234) });
    const failure = await devSecretReader({ project: "acme", env: "dev", registry, paths })(
      "auth-session-secret",
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.message).toContain("auth-session-secret");
  });

  test("refuses outside dev, and never opens the file — #159's rule, on the reading half", async () => {
    // The dev secrets file is on the operator's disk under every `--env`, so a reader that only asks the
    // filesystem happily hands a prepared set a live dev secret under `--env prod` and writes it into
    // production rows. A reader that reads dev secrets for a managed environment is the same hole as a
    // writer, and #159 is absolute: the rule lives in the reader, not in whoever calls it.
    const { paths } = await project({ "auth-session-secret": envelope("s3cr3t") });
    for (const env of ["staging", "prod"]) {
      const failure = await devSecretReader({ project: "acme", env, registry, paths })("auth-session-secret").catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PithyError);
      expect((failure as PithyError).payload.message).toContain(env);
      // The value never appears in the refusal, in `message` or in `detail`.
      expect(JSON.stringify((failure as PithyError).payload)).not.toContain("s3cr3t");
    }
  });

  test("refuses an environment it cannot place — permissive-by-default is the bug", async () => {
    // Not "unless it is prod". Unless it is provably dev. An unknown environment, an empty one, or a
    // spelling nothing resolves refuses, because the dangerous default is the permissive one.
    const { paths } = await project({ "auth-session-secret": envelope("s3cr3t") });
    for (const env of ["", "Dev", "development", "local"]) {
      await expect(devSecretReader({ project: "acme", env, registry, paths })("auth-session-secret")).rejects.toThrow(
        PithyError,
      );
    }
  });

  test("an unreadable secrets file is not an absent one — only ENOENT answers undefined", async () => {
    // The `catch(() => undefined)` shape that cost `.dev.vars` its contents twice elsewhere. Here it
    // costs a prepared set its secret: the set writes a row against `undefined` and the run says nothing.
    const { paths, path } = await project({ "auth-session-secret": envelope("s3cr3t") });
    await chmod(path, 0o200);

    const failure = await devSecretReader({ project: "acme", env: "dev", registry, paths })(
      "auth-session-secret",
    ).catch((error: unknown) => error);
    await chmod(path, 0o600);

    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.detail).toContain("EACCES");
  });

  test("reads the file once, however many secrets a run asks for", async () => {
    // Two Workers in one fan-out must not observe one hand-edited file in two states — the same rule
    // `dev.json` gets, for the same reason.
    const { paths, path } = await project({
      "auth-session-secret": envelope("first"),
      "app-vendor-token": envelope("vendor-token"),
    });
    const read = devSecretReader({ project: "acme", env: "dev", registry, paths });
    expect(await read("auth-session-secret")).toBe("first");
    await writeFile(path, JSON.stringify({ "auth-session-secret": envelope("second") }));
    expect(await read("auth-session-secret")).toBe("first");
    expect(await read("app-vendor-token")).toBe("vendor-token");
  });
});

describe("writeSeedArtifact", () => {
  test("writes under the gitignored logs directory", async () => {
    const dir = await tempDir();
    const written = await writeSeedArtifact(dir, { file: "dev-login.json", contents: "{}\n" });
    expect(written).toBe(join(dir, SEED_ARTIFACT_DIR, "dev-login.json"));
    expect(await readFile(written, "utf8")).toBe("{}\n");
  });

  test("refuses a name that would escape logs/", async () => {
    const dir = await tempDir();
    const failure = await writeSeedArtifact(dir, { file: "../committed.json", contents: "{}" }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PithyError);
  });

  test("the directory it writes to is gitignored by the starter template, not merely chosen", async () => {
    const ignore = await readFile(join(import.meta.dirname, "../../../../templates/starter/gitignore"), "utf8");
    const lines = ignore.split("\n").map((line) => line.trim());
    expect(lines).toContain(`${SEED_ARTIFACT_DIR}/`);
  });
});
