// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { EXIT } from "../terminal/exitClass";
import { removeTempDir } from "../test-utils/tempRepo";

const run = promisify(execFile);
const bin = join(import.meta.dirname, "..", "bin.ts");

/** The account the fixture's `pithy.config.ts` pins. */
const PINNED = "acc0unt0000000000000000000000000";
/** The account the shell's credentials are for: a different one, as in a shell that works on several. */
const OTHER = "0ther000000000000000000000000000";

/** One run of the real binary, as an outcome rather than as an exception. */
async function pithy(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("bun", [bin, ...args], options);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** Project `replay` pinning {@link PINNED}, with one Worker `board` that composes nothing. */
async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-739-"));
  await writeFile(
    join(dir, "pithy.config.ts"),
    `export default { name: "replay", environments: ["staging"], cloudflare: { accountId: "${PINNED}" } };\n`,
  );
  const worker = join(dir, "apps", "board");
  await mkdir(worker, { recursive: true });
  await writeFile(join(worker, "wrangler.jsonc"), `{ "name": "replay-board" }\n`);
  await writeFile(join(worker, "pithy.config.ts"), "export default { capabilities: [] };\n");
  return dir;
}

/** A config directory of the run's own, and credentials for {@link OTHER} in the environment. */
function otherAccount(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PITHY_CONFIG_DIR: join(dir, ".pithy-config"),
    NO_COLOR: "1",
    CLOUDFLARE_ACCOUNT_ID: OTHER,
    CLOUDFLARE_API_TOKEN: "stub-token",
  };
}

/**
 * **A `dev` seed runs on this machine, so another account's credentials do not stop it (#739).**
 *
 * The audit a `dev` seed builds is inert by design, and it used to resolve the credentials on the way to
 * that no-op — so the account guard refused a run that would have used none of them. A real run was worse
 * than refused: the dev secrets were already written when the throw came. A remote env is untouched and
 * still refuses, because there the credentials are what the rows go through.
 */
describe("pithy seed under another account's credentials — #739", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await removeTempDir(dir);
  });

  test("a dev seed runs and exits 0", async () => {
    const dir = await project();
    dirs.push(dir);

    const { code, stdout, stderr } = await pithy(["seed"], { cwd: dir, env: otherAccount(dir) });

    expect(stderr).not.toContain("pins Cloudflare account");
    expect(code).toBe(0);
    expect(stdout).toContain("Done.");
  });

  test("its dry run exits 0", async () => {
    const dir = await project();
    dirs.push(dir);

    const { code, stdout } = await pithy(["seed", "--dry-run"], { cwd: dir, env: otherAccount(dir) });

    expect(code).toBe(0);
    expect(stdout).toContain("Dry run. Nothing written.");
  });

  test("a remote env still refuses with the mismatch", async () => {
    const dir = await project();
    dirs.push(dir);

    const { code, stderr } = await pithy(["seed", "--env", "staging", "--dry-run"], {
      cwd: dir,
      env: otherAccount(dir),
    });

    expect(code).toBe(EXIT.precondition);
    expect(stderr).toContain(
      `This project pins Cloudflare account ${PINNED}, and the environment supplies credentials for ${OTHER}.`,
    );
  });
});
