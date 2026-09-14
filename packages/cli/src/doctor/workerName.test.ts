// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HOST_WORKERS } from "../capabilities/hostRegistry";
import { assertWorkerName } from "../project/scaffold";
import {
  checkWorkerNames,
  describeReservedWorkerName,
  describeWorkerName,
  describeWorkerNameConvention,
  type WorkerNameCheck,
} from "./workerName";

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
  const stanza = (env: string) => ({
    // The name `pithy init` stamps since #580 — `<project>-<env>-<worker>`, not wrangler's suffix.
    name: `${project}-${env}-${worker}`,
    vars: { ENVIRONMENT: env, PROJECT: project, WORKER: worker },
  });
  return {
    name: `${project}-${worker}`,
    vars: { ENVIRONMENT: "dev", PROJECT: project, WORKER: worker },
    env: { staging: stanza("staging"), prod: stanza("prod") },
  };
}

describe("checkWorkerNames", () => {
  test("a scaffolded worker agrees with itself", async () => {
    await writeWorker("api", scaffolded("acme", "api"));
    expect(await checkWorkerNames(dir)).toEqual({ state: "ok", mismatches: [], reserved: [], convention: [] });
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
    expect(await checkWorkerNames(dir)).toEqual({ state: "ok", mismatches: [], reserved: [], convention: [] });
  });

  test("a worker declaring no WORKER var declares nothing to disagree with", async () => {
    await writeWorker("api", { name: "acme-api", vars: { ENVIRONMENT: "dev" } });
    expect(await checkWorkerNames(dir)).toEqual({ state: "ok", mismatches: [], reserved: [], convention: [] });
  });

  test("an unreadable wrangler.jsonc is could-not-check, not a pass", async () => {
    const workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    await writeFile(join(workerDir, "wrangler.jsonc"), "{ not json");

    expect(await checkWorkerNames(dir)).toEqual({
      state: "could-not-check",
      mismatches: [],
      reserved: [],
      convention: [],
    });
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
    expect(await checkWorkerNames(dir)).toEqual({ state: "ok", mismatches: [], reserved: [], convention: [] });
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

/**
 * The two things #580 asks of an existing project: the name it must not have, and the name it need not have.
 *
 * Both read the same `env.<name>.name` field, and they are held apart on purpose. A clash with a
 * capability's host Worker is established by the project's own files and fails the exit — deploying over
 * it is silent and takes a capability's Workflows down with it. A Worker still on wrangler's suffix is a
 * Worker whose name is simply the adopter's; it is reported and nothing more.
 */
/**
 * **Every name this report recommends is a name the kit would let you create.**
 *
 * The convention note is advice, and `<project>-<env>-<worker>` is byte-identical to a capability's own
 * host Worker when the worker is called `email` — so the friendly optional suggestion was the exact string
 * the reserved check two blocks up fails you for, and an adopter who took it created the collision.
 *
 * The refusal is the oracle, not a restatement of it: this asks the one function `pithy init --worker`,
 * `pithy worker add` and `pithy worker rename` ask, so the ninth capability to ship a host Worker holds
 * doctor's advice to the same rule the day it is registered.
 */
function everyRecommendationIsCreatable(check: WorkerNameCheck): void {
  for (const note of check.convention) expect(() => assertWorkerName(note.worker)).not.toThrow();
}

describe("environment names", () => {
  test.each(HOST_WORKERS.map((spec) => spec.capability))(
    "a stanza named after the %s host Worker is a fault, not a note",
    async (capability) => {
      await writeWorker("api", {
        name: "acme-api",
        env: { staging: { name: `acme-staging-${capability}` } },
      });

      const check = await checkWorkerNames(dir);
      expect(check.state).toBe("drifted");
      expect(check.reserved).toEqual([
        { worker: "api", env: "staging", name: `acme-staging-${capability}`, capability },
      ]);
      expect(check.convention).toEqual([]);
    },
  );

  test("a worker still on wrangler's suffix is reported and stays ok", async () => {
    await writeWorker("board", { name: "acme-board", env: { staging: {}, prod: {} } });

    const check = await checkWorkerNames(dir);
    expect(check.state).toBe("ok");
    expect(check.reserved).toEqual([]);
    expect(check.convention).toEqual([
      {
        worker: "board",
        environments: [
          { env: "staging", current: "acme-board-staging", convention: "acme-staging-board" },
          { env: "prod", current: "acme-board-prod", convention: "acme-prod-board" },
        ],
      },
    ]);
    everyRecommendationIsCreatable(check);
  });

  test("a scaffolded worker is already on the convention and says nothing", async () => {
    await writeWorker("board", scaffolded("acme", "board"));

    const check = await checkWorkerNames(dir);
    expect(check.convention).toEqual([]);
    expect(check.reserved).toEqual([]);
  });

  test("a name that clashes with nothing is neither", async () => {
    // `acme-staging-emailer` is not `acme-staging-email`. A prefix is not a collision, and reporting one
    // would refuse a legitimate worker on the strength of a shared first seven characters.
    await writeWorker("emailer", { name: "acme-emailer", env: { staging: { name: "acme-staging-emailer" } } });

    const check = await checkWorkerNames(dir);
    expect(check.state).toBe("ok");
    expect(check.reserved).toEqual([]);
    expect(check.convention).toEqual([]);
  });

  test.each(HOST_WORKERS.map((spec) => spec.capability))(
    "a worker directory called %s is never advised onto the name that would replace that host Worker",
    async (capability) => {
      // An `apps/<capability>` that predates the refusal, or was migrated in. It deploys as
      // `acme-<capability>-staging` today, which collides with nothing. The convention would put it on
      // `acme-staging-<capability>` — the capability's own host Worker, and the one name the block above
      // fails the exit over. There is no advice to give here, so none is given.
      await writeWorker(capability, { name: `acme-${capability}`, env: { staging: {}, prod: {} } });

      const check = await checkWorkerNames(dir);
      expect(check.state).toBe("ok");
      expect(check.reserved).toEqual([]);
      expect(check.convention).toEqual([]);
      everyRecommendationIsCreatable(check);
    },
  );

  test("a config with no top-level name still has its stanzas judged against the host registry", async () => {
    // Legal, and the shape this repo's own dashboard prod stanza takes: every stanza names itself, so
    // there is no top-level name to suffix. Only the convention half ever needed one — the reserved half
    // composes `<project>-<env>-<capability>` and compares it to a name the stanza declares.
    await writeWorker("api", { env: { staging: { name: "acme-staging-email" } } });

    const check = await checkWorkerNames(dir);
    expect(check.state).toBe("drifted");
    expect(check.reserved).toEqual([
      { worker: "api", env: "staging", name: "acme-staging-email", capability: "email" },
    ]);
    expect(check.convention).toEqual([]);
  });

  test("with no top-level name there is no suffix to report", async () => {
    // Wrangler suffixes the top-level name, so with none there is nowhere for a nameless stanza to land
    // and nothing to say about where it lands.
    await writeWorker("api", { env: { staging: {} } });

    const check = await checkWorkerNames(dir);
    expect(check.state).toBe("ok");
    expect(check.convention).toEqual([]);
  });

  test("with no readable project name, no environment name is judged either way", async () => {
    // Both answers compose `<project>-<env>-…`. Guessing the project would invent a clash with a host
    // Worker this project may not even have.
    await rm(join(dir, "pithy.config.ts"));
    await writeWorker("api", { name: "acme-api", env: { staging: { name: "acme-staging-email" }, prod: {} } });

    const check = await checkWorkerNames(dir);
    expect(check.reserved).toEqual([]);
    expect(check.convention).toEqual([]);
  });
});

describe("describeWorkerNameConvention", () => {
  test("says where it lands, where the convention puts it, and what moving costs", () => {
    const lines = describeWorkerNameConvention({
      worker: "board",
      environments: [{ env: "prod", current: "acme-board-prod", convention: "acme-prod-board" }],
    });
    expect(lines[0]).toContain("acme-board-prod");
    expect(lines[0]).toContain("acme-prod-board");
    // The price is said every time the shape is, or the note reads as an instruction.
    expect(lines[1]).toContain("Optional");
    expect(lines[1]).toContain("old name still answers");
  });
});

describe("describeReservedWorkerName", () => {
  test("names the capability whose Worker the deploy would replace", () => {
    const sentence = describeReservedWorkerName({
      worker: "api",
      env: "staging",
      name: "acme-staging-email",
      capability: "email",
    });
    expect(sentence).toContain("email capability's own host Worker");
    // The environment is the line's label in the report, so the sentence must not repeat it.
    expect(sentence.startsWith("staging")).toBe(false);
  });
});
