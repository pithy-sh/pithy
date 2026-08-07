// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_SECRETS_FILE } from "@pithy-sh/secrets/src/dev/devSecretsFile";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureDevSecretsIgnored } from "./gitignore";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-dev-secrets-ignore-"));
});
afterEach(async () => {
  await chmod(dir, 0o700).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

/** The project's `.gitignore` body, or `null` when it has none. */
function gitignore(): Promise<string | null> {
  return readFile(join(dir, ".gitignore"), "utf8").catch(() => null);
}

describe("ensureDevSecretsIgnored", () => {
  test("a .gitignore that already covers both is not rewritten — no churn on every pithy add", async () => {
    const content = `node_modules/\n${DEV_SECRETS_FILE}\n${DEV_SECRETS_FILE}.tmp\n`;
    await writeFile(join(dir, ".gitignore"), content);

    const result = await ensureDevSecretsIgnored(dir);

    expect(result).toEqual({ covered: true, added: [], reason: null });
    expect(await gitignore()).toBe(content);
  });

  test("a project scaffolded before this change gains the .tmp line", async () => {
    // Every project that predates it, `pithy-sh/dashboard` included: `.dev.vars.*` covers `.dev.vars`'s
    // temp sibling, and nothing covered this one. It survives a SIGINT holding full plaintext.
    await writeFile(join(dir, ".gitignore"), `${DEV_SECRETS_FILE}\n!.dev.secrets.example.jsonc\n`);

    const result = await ensureDevSecretsIgnored(dir);

    expect(result.covered).toBe(true);
    expect(result.added).toEqual([`${DEV_SECRETS_FILE}.tmp`]);
    const content = (await gitignore()) ?? "";
    expect(content).toContain("!.dev.secrets.example.jsonc");
    expect(content).toContain(`${DEV_SECRETS_FILE}.tmp`);
  });

  test("a project with no .gitignore at all gets one — an unignored secret is the whole risk", async () => {
    const result = await ensureDevSecretsIgnored(dir);

    expect(result.covered).toBe(true);
    expect(result.added).toEqual([DEV_SECRETS_FILE, `${DEV_SECRETS_FILE}.tmp`]);
    expect(await gitignore()).toContain(DEV_SECRETS_FILE);
  });

  test("a glob that already covers both is honoured — nothing redundant is appended", async () => {
    await writeFile(join(dir, ".gitignore"), ".dev.secrets.*\n");

    const result = await ensureDevSecretsIgnored(dir);

    expect(result).toEqual({ covered: true, added: [], reason: null });
  });

  test("the example file's negation is not mistaken for the real file's", async () => {
    // `!.dev.secrets.example.jsonc` re-includes a committed template. It says nothing about the file
    // holding values, and reading it as an un-ignore would refuse every add in a scaffolded project.
    await writeFile(join(dir, ".gitignore"), `!.dev.secrets.example.jsonc\n${DEV_SECRETS_FILE}.tmp\n`);

    const result = await ensureDevSecretsIgnored(dir);

    expect(result.added).toEqual([DEV_SECRETS_FILE]);
  });

  test("a negation of the file itself un-ignores it, and the rule after it wins again", async () => {
    await writeFile(join(dir, ".gitignore"), `${DEV_SECRETS_FILE}\n!${DEV_SECRETS_FILE}\n`);

    const result = await ensureDevSecretsIgnored(dir);

    expect(result.covered).toBe(true);
    expect(result.added).toContain(DEV_SECRETS_FILE);
    // Appended last, and gitignore's last match wins — so the file is ignored again.
    expect(((await gitignore()) ?? "").trimEnd().endsWith(`${DEV_SECRETS_FILE}.tmp`)).toBe(true);
  });

  test("a comment naming the file ignores nothing", async () => {
    await writeFile(join(dir, ".gitignore"), `# ${DEV_SECRETS_FILE}\n\n`);

    const result = await ensureDevSecretsIgnored(dir);

    expect(result.added).toEqual([DEV_SECRETS_FILE, `${DEV_SECRETS_FILE}.tmp`]);
  });

  test("a directory-only rule does not cover a file of the same name", async () => {
    await writeFile(join(dir, ".gitignore"), `${DEV_SECRETS_FILE}/\n`);

    expect((await ensureDevSecretsIgnored(dir)).added).toContain(DEV_SECRETS_FILE);
  });

  test("an unwritable .gitignore refuses, and says exactly what to add", async () => {
    await chmod(dir, 0o500);

    const result = await ensureDevSecretsIgnored(dir);

    expect(result.covered).toBe(false);
    expect(result.reason).toContain(DEV_SECRETS_FILE);
    expect(result.reason).toContain(`${DEV_SECRETS_FILE}.tmp`);
    expect(result.reason).toContain(".gitignore");
  });
});
