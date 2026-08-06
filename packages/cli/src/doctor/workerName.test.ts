// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { checkWorkerNames, describeWorkerName } from "./workerName";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-worker-name-"));
  await writeFile(join(dir, "pithy.config.ts"), 'export default { name: "acme" };\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Write one worker under `apps/<name>/wrangler.jsonc` — the directory, the script name, and the vars. */
async function writeWorker(name: string, config: Record<string, unknown>): Promise<void> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  await writeFile(join(workerDir, "wrangler.jsonc"), JSON.stringify(config, null, 2));
}

/** The scaffolded shape: `<project>-<dir>` deployed, `WORKER` equal to the directory in every stanza. */
function scaffolded(project: string, worker: string): Record<string, unknown> {
  return {
    name: `${project}-${worker}`,
    vars: { ENVIRONMENT: "dev", PROJECT: project, WORKER: worker },
    env: {
      staging: { vars: { ENVIRONMENT: "staging", PROJECT: project, WORKER: worker } },
      prod: { vars: { ENVIRONMENT: "prod", PROJECT: project, WORKER: worker } },
    },
  };
}

describe("checkWorkerNames", () => {
  test("a scaffolded worker agrees with itself", async () => {
    await writeWorker("api", scaffolded("acme", "api"));
    expect(await checkWorkerNames(dir)).toEqual({ state: "ok", mismatches: [] });
  });

  test("catches the hand-rename: the directory moved, the script name and WORKER stayed", async () => {
    // Exactly what the dashboard did — `git mv apps/api apps/board`, then seven files edited by hand.
    await writeWorker("board", scaffolded("acme", "api"));

    const check = await checkWorkerNames(dir);
    expect(check.state).toBe("drifted");
    expect(check.mismatches).toEqual([
      { worker: "board", stamp: "name", declared: "acme-api", expected: "acme-board", envs: [] },
      { worker: "board", stamp: "vars.WORKER", declared: "api", expected: "board", envs: ["dev", "staging", "prod"] },
    ]);
  });

  test("one WORKER var missed in one environment is still drift", async () => {
    const config = scaffolded("acme", "board");
    const envs = config.env as Record<string, { vars: Record<string, string> } | undefined>;
    const prod = envs.prod;
    if (!prod) throw new Error("the fixture has no prod stanza");
    prod.vars.WORKER = "api";
    await writeWorker("board", config);

    const check = await checkWorkerNames(dir);
    expect(check.state).toBe("drifted");
    expect(check.mismatches).toEqual([
      { worker: "board", stamp: "vars.WORKER", declared: "api", expected: "board", envs: ["prod"] },
    ]);
  });

  test("a script name the adopter brought with them is theirs, not drift", async () => {
    // The migrate-an-existing-Worker-in path: `my-service` was never composed from this project's name,
    // so nothing local establishes that it should have been. Shape narrows; it does not find.
    await writeWorker("api", { name: "my-service", vars: { WORKER: "api" } });
    expect(await checkWorkerNames(dir)).toEqual({ state: "ok", mismatches: [] });
  });

  test("a worker declaring no WORKER var declares nothing to disagree with", async () => {
    await writeWorker("api", { name: "acme-api", vars: { ENVIRONMENT: "dev" } });
    expect(await checkWorkerNames(dir)).toEqual({ state: "ok", mismatches: [] });
  });

  test("an unreadable wrangler.jsonc is could-not-check, not a pass", async () => {
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), "{ not json");

    expect(await checkWorkerNames(dir)).toEqual({ state: "could-not-check", mismatches: [] });
  });

  test("a mismatch it could read outranks a worker it could not", async () => {
    // Half an answer with a fault in it is still a fault. Only a read that found nothing degrades.
    await writeWorker("board", scaffolded("acme", "api"));
    const broken = join(dir, "apps", "other");
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, "wrangler.jsonc"), "{ not json");

    expect((await checkWorkerNames(dir)).state).toBe("drifted");
  });

  test("with no readable project name, the script name is not judged and WORKER still is", async () => {
    await rm(join(dir, "pithy.config.ts"));
    await writeWorker("board", scaffolded("acme", "api"));

    const check = await checkWorkerNames(dir);
    expect(check.mismatches).toEqual([
      { worker: "board", stamp: "vars.WORKER", declared: "api", expected: "board", envs: ["dev", "staging", "prod"] },
    ]);
  });

  test("a project with no workers has nothing to disagree", async () => {
    expect(await checkWorkerNames(dir)).toEqual({ state: "ok", mismatches: [] });
  });
});

describe("describeWorkerName", () => {
  test("a script name says what deploys, and what the directory says instead", () => {
    expect(
      describeWorkerName({ worker: "board", stamp: "name", declared: "acme-api", expected: "acme-board", envs: [] }),
    ).toBe("deploys as acme-api, not acme-board");
  });

  test("a WORKER var says what it stamps, since that is what tells two workers' events apart", () => {
    expect(
      describeWorkerName({
        worker: "board",
        stamp: "vars.WORKER",
        declared: "api",
        expected: "board",
        envs: ["dev"],
      }),
    ).toBe("stamps events as api, not board");
  });
});
