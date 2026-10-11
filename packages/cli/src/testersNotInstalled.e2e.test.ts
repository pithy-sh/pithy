// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { scaffoldProject } from "./project/scaffold";
import { EXIT } from "./terminal/exitClass";
import { linkKitPackages } from "./test-utils/linkKit";

/**
 * **`pithy testers` in a project that never added testers: exit 3, one error line, and `pithy add` as the fix (#697).**
 *
 * `capabilityLoadError` became async when a `not-installed` refusal started naming its `fix`, and the three testers
 * loaders kept `throw capabilityLoadError(…)`. That throws a pending Promise, not the refusal: the funnel cannot
 * read a code off it, so the run ended unclassified, with no `fix`, and the sentence the classifier wrote was lost.
 * A unit test of the classifier could not see it, because the classifier was right. Only the real binary, run where
 * the package is missing, reads what an operator reads. `ci/thrownPromises.test.ts` keeps the shape from coming back.
 */

const run = promisify(execFile);
const bin = join(import.meta.dirname, "bin.ts");

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-testers-missing-"));
  await scaffoldProject({ targetDir: dir, appName: "acme", worker: "api" });
  await linkKitPackages(dir, ["core"]);
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Run the real bin in the project, with the runner's own signals scrubbed, and hand back the streams and the exit. */
async function pithy(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PITHY_NO_UPDATE_NOTIFIER: "1",
    PITHY_CONFIG_DIR: join(dir, ".config"),
    CLOUDFLARE_ACCOUNT_ID: "acct",
    CLOUDFLARE_API_TOKEN: "tok",
  };
  for (const key of ["PITHY_JSON", "PITHY_NONINTERACTIVE", "CI"]) delete env[key];
  try {
    const { stdout, stderr } = await run("bun", [bin, ...args], { cwd: dir, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

describe("pithy testers, with @pithy-sh/testers not installed", () => {
  test.each([
    ["testers list", ["testers", "list", "--env", "dev", "--json"]],
    ["testers provision", ["testers", "provision", "--json"]],
  ])(
    "%s exits 3 with the refusal and its fix",
    async (_name, args) => {
      const { code, stdout, stderr } = await pithy(args);
      expect(stdout).toBe("");
      expect(stderr.trimEnd().split("\n")).toHaveLength(1);
      const line = JSON.parse(stderr) as { error: Record<string, unknown> };
      expect(line.error).toMatchObject({
        code: "core/precondition_failed",
        message: "The testers capability is not installed.",
        exit: EXIT.precondition,
        retryable: false,
        fix: "pithy add testers --with-prerequisites",
      });
      expect(code).toBe(EXIT.precondition);
    },
    60_000,
  );

  test("the text render says what is missing and what to run", async () => {
    const { code, stderr } = await pithy(["testers", "list", "--env", "dev"]);
    expect(stderr).toContain("The testers capability is not installed.");
    expect(stderr).toContain("pithy add testers");
    expect(code).toBe(EXIT.precondition);
  }, 60_000);
});
