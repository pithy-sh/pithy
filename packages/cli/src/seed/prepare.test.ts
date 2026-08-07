// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { SEED_ARTIFACT_DIR } from "@pithy-sh/core/src/seed/devLogin";
import { describe, expect, test } from "vitest";
import { stateDir } from "../notifier/state";
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
  test("resolves a secret from the project's .dev.vars", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, ".dev.vars"), "# a comment\nauth-session-secret=s3cr3t\n");
    expect(await devSecretReader({ projectDir: dir, env: "dev" })("auth-session-secret")).toBe("s3cr3t");
  });

  test("is undefined for a name the file does not set, and when there is no file", async () => {
    const dir = await tempDir();
    expect(await devSecretReader({ projectDir: dir, env: "dev" })("auth-session-secret")).toBeUndefined();
    await writeFile(join(dir, ".dev.vars"), "OTHER=1\n");
    expect(await devSecretReader({ projectDir: dir, env: "dev" })("auth-session-secret")).toBeUndefined();
  });

  test("refuses outside dev, and never opens the file — #159's rule, on the reading half", async () => {
    // `.dev.vars` is on the operator's disk in every environment, so a reader that only asks the
    // filesystem happily hands a prepared set a live dev secret under `--env prod` and writes it into
    // production rows. A reader that reads dev secrets for a managed environment is the same hole as a
    // writer, and #159 is absolute: the rule lives in the reader, not in whoever calls it.
    const dir = await tempDir();
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=s3cr3t\n");
    for (const env of ["staging", "prod"]) {
      const failure = await devSecretReader({ projectDir: dir, env })("auth-session-secret").catch(
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
    const dir = await tempDir();
    await writeFile(join(dir, ".dev.vars"), "auth-session-secret=s3cr3t\n");
    for (const env of ["", "Dev", "development", "local"]) {
      await expect(devSecretReader({ projectDir: dir, env })("auth-session-secret")).rejects.toThrow(PithyError);
    }
  });

  test("an unreadable .dev.vars is not an absent one — only ENOENT answers undefined", async () => {
    // The `catch(() => undefined)` shape that cost `.dev.vars` its contents twice elsewhere. Here it
    // costs a prepared set its secret: the set writes a row against `undefined` and the run says nothing.
    const dir = await tempDir();
    const path = join(dir, ".dev.vars");
    await writeFile(path, "auth-session-secret=s3cr3t\n");
    await chmod(path, 0o200);

    const failure = await devSecretReader({ projectDir: dir, env: "dev" })("auth-session-secret").catch(
      (error: unknown) => error,
    );
    await chmod(path, 0o600);

    expect(failure).toBeInstanceOf(PithyError);
    expect((failure as PithyError).payload.detail).toContain("EACCES");
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
