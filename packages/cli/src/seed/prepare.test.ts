// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { SEED_ARTIFACT_DIR } from "@pithy-sh/core/src/seed/devLogin";
import { describe, expect, test } from "vitest";
import { devPreferencesPath, devSecretReader, readDevPreferences, writeSeedArtifact } from "./prepare";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pithy-prepare-"));
}

describe("devPreferencesPath", () => {
  test("respects XDG_CONFIG_HOME", () => {
    expect(devPreferencesPath("acme", { XDG_CONFIG_HOME: "/xdg", HOME: "/home/dev" })).toBe("/xdg/acme/dev.json");
  });

  test("falls back to ~/.config", () => {
    expect(devPreferencesPath("acme", { HOME: "/home/dev" })).toBe("/home/dev/.config/acme/dev.json");
  });

  test("ignores an empty XDG_CONFIG_HOME rather than resolving against nothing", () => {
    expect(devPreferencesPath("acme", { XDG_CONFIG_HOME: "", HOME: "/home/dev" })).toBe(
      "/home/dev/.config/acme/dev.json",
    );
  });
});

describe("readDevPreferences", () => {
  test("is undefined when the developer has not opted in", async () => {
    const home = await tempDir();
    expect(await readDevPreferences("acme", { XDG_CONFIG_HOME: home })).toBeUndefined();
  });

  test("reads the file the developer wrote", async () => {
    const home = await tempDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "acme"), { recursive: true });
    await writeFile(join(home, "acme", "dev.json"), '{ "user": "ada@example.com" }');
    expect(await readDevPreferences("acme", { XDG_CONFIG_HOME: home })).toEqual({ user: "ada@example.com" });
  });

  test("treats an unparseable file as absent — a half-typed preference never fails a seed", async () => {
    const home = await tempDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "acme"), { recursive: true });
    await writeFile(join(home, "acme", "dev.json"), "{ not json");
    expect(await readDevPreferences("acme", { XDG_CONFIG_HOME: home })).toBeUndefined();
  });
});

describe("devSecretReader", () => {
  test("resolves a secret from the project's .dev.vars", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, ".dev.vars"), "# a comment\nauth-session-secret=s3cr3t\n");
    expect(await devSecretReader(dir)("auth-session-secret")).toBe("s3cr3t");
  });

  test("is undefined for a name the file does not set, and when there is no file", async () => {
    const dir = await tempDir();
    expect(await devSecretReader(dir)("auth-session-secret")).toBeUndefined();
    await writeFile(join(dir, ".dev.vars"), "OTHER=1\n");
    expect(await devSecretReader(dir)("auth-session-secret")).toBeUndefined();
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
