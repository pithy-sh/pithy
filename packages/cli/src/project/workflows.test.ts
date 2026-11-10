// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fixOf } from "../terminal/exitClass";
import { reconcileAppWorkflows } from "./appWorkflows";
import { composeFor } from "./composeFor";
import {
  assertWorkflowsBound,
  checkWorkflows,
  describeWorkflowDrift,
  workflowDrift,
  workflowDriftFix,
  workflowExports,
} from "./workflows";

/**
 * **What the app capability declares is what the environment's stanza binds**, in both directions: a job declared
 * and never synced is drift, and so is a binding nothing declares. A missing binding, a stale cron and a name
 * carrying the wrong environment are one fault with one remedy, so each case below is the same comparison.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-workflows-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The project every derived Workflow name leads with — `requireProjectName`'s answer, never a guess. */
const PROJECT = "replay";

/** The root config. Its `name` composes every Workflow name; `environments` is what `checkWorkflows` walks. */
async function project(environments?: string): Promise<void> {
  const declaration = environments === undefined ? "" : `, environments: ${environments}`;
  await writeFile(join(dir, "pithy.config.ts"), `export default { name: "${PROJECT}"${declaration} };\n`);
}

/** One job as an app capability declares it. `params` is never read here — only the CLI-facing fields are. */
interface Job {
  binding: string;
  className?: string;
  schedule?: string;
}

/**
 * One Worker under `apps/<name>`, with a `wrangler.jsonc` and an app capability declaring `jobs`.
 *
 * The Worker name and the project name differ on purpose — a Worker deploys as `<project>-<worker>`
 * and a Workflow as `<project>-<env>-<capability>-<job>`, so a fixture where the two match hides
 * every mistake that swaps one for the other.
 */
async function worker(
  name: string,
  wrangler: Record<string, unknown>,
  jobs?: Record<string, Job>,
  libraries = "[]",
): Promise<string> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  await writeFile(
    join(workerDir, "wrangler.jsonc"),
    `${JSON.stringify({ name: `${PROJECT}-${name}`, ...wrangler }, null, 2)}\n`,
  );
  await writeFile(join(workerDir, "pithy.worker.jsonc"), '{ "dev": {} }\n');
  const app = jobs === undefined ? "" : `app: { name: "${name}", workflows: ${JSON.stringify(jobs)} },`;
  await writeFile(
    join(workerDir, "pithy.config.ts"),
    `const config = {\n  ${app}\n  capabilities: ${libraries}\n};\nexport default config;\n`,
  );
  return workerDir;
}

/** A digest job: bound as `DIGEST`, fired nightly. */
const DIGEST: Record<string, Job> = {
  digest: { binding: "DIGEST", className: "DigestWorkflow", schedule: "0 4 * * *" },
};

/** What `pithy worker sync` writes into `env.prod` for {@link DIGEST}. */
const DIGEST_PROD = { binding: "DIGEST", name: "replay-prod-board-digest", class_name: "DigestWorkflow" };

describe("workflowDrift", () => {
  /** A job declared and `worker sync` never run. */
  test("a declared Workflow the stanza does not bind is drift", async () => {
    await worker("board", { env: { prod: {} } }, DIGEST);

    expect(await workflowDrift(dir, PROJECT, ["prod"])).toEqual([
      {
        worker: "board",
        env: "prod",
        fault: "unsynced-stanza",
        declared: { workflows: [DIGEST_PROD], crons: ["0 4 * * *"] },
        bound: { workflows: [], crons: [] },
      },
    ]);
  });

  /**
   * And the writer is the whole difference. Run through `reconcileAppWorkflows` — the same function
   * `pithy worker sync` calls, not a hand-built fixture of what it is imagined to write — the config is
   * clean, which is the only way the reader and the writer cannot drift.
   */
  test("and pithy worker sync makes it clean, with no other edit", async () => {
    const workerDir = await worker("board", { env: { prod: {} } }, DIGEST);
    const app = { name: "board", workflows: DIGEST } as unknown as Parameters<typeof reconcileAppWorkflows>[0]["app"];

    await reconcileAppWorkflows({ workerDir, project: PROJECT, app, env: "prod" });

    expect(await workflowDrift(dir, PROJECT, ["prod"])).toEqual([]);
  });

  /** The reverse, and the same fault: the stanza binds a job the declaration no longer names. */
  test("a binding the declaration no longer names is drift too", async () => {
    await worker("board", { env: { prod: { workflows: [DIGEST_PROD], triggers: { crons: ["0 4 * * *"] } } } }, {});

    expect(await workflowDrift(dir, PROJECT, ["prod"])).toEqual([
      {
        worker: "board",
        env: "prod",
        fault: "unsynced-stanza",
        declared: { workflows: [], crons: [] },
        bound: { workflows: [DIGEST_PROD], crons: ["0 4 * * *"] },
      },
    ]);
  });

  /** A cron is half the declaration, so a schedule nothing declares is the same disagreement. */
  test("a stale cron beside the right bindings is drift", async () => {
    await worker(
      "board",
      { env: { prod: { workflows: [DIGEST_PROD], triggers: { crons: ["0 4 * * *", "0 5 * * *"] } } } },
      DIGEST,
    );

    const drift = await workflowDrift(dir, PROJECT, ["prod"]);
    expect(drift[0]?.bound.crons).toEqual(["0 4 * * *", "0 5 * * *"]);
    expect(drift[0]?.declared.crons).toEqual(["0 4 * * *"]);
  });

  /**
   * The binding name is present and the deployed name is another environment's — the shape a
   * copy-pasted stanza produces, and the one a check that only asked "is `DIGEST` bound?" would pass.
   */
  test("a binding carrying another environment's Workflow name is drift", async () => {
    await worker(
      "board",
      {
        env: {
          prod: {
            workflows: [{ ...DIGEST_PROD, name: "replay-staging-board-digest" }],
            triggers: { crons: ["0 4 * * *"] },
          },
        },
      },
      DIGEST,
    );

    expect((await workflowDrift(dir, PROJECT, ["prod"]))[0]?.fault).toBe("unsynced-stanza");
  });

  /** Order in the file is not part of the invariant — Cloudflare reads a table, not a list. */
  test("the same table in another order is not drift", async () => {
    const sweep = { binding: "SWEEP", name: "replay-prod-board-sweep", class_name: "SweepWorkflow" };
    await worker(
      "board",
      { env: { prod: { workflows: [sweep, DIGEST_PROD], triggers: { crons: ["0 4 * * *"] } } } },
      { digest: DIGEST.digest as Job, sweep: { binding: "SWEEP", className: "SweepWorkflow" } },
    );

    expect(await workflowDrift(dir, PROJECT, ["prod"])).toEqual([]);
  });

  /** A `script_name` entry is a library capability's, bound to its own host Worker. Never the app's. */
  test("a provisioned entry belongs to another script and is not compared", async () => {
    await worker(
      "board",
      {
        env: {
          prod: {
            workflows: [
              {
                binding: "STORAGE_SWEEP",
                name: "replay-prod-storage-sweep",
                class_name: "StorageSweepWorkflow",
                script_name: "replay-prod-storage",
              },
              DIGEST_PROD,
            ],
            triggers: { crons: ["0 4 * * *"] },
          },
        },
      },
      DIGEST,
    );

    expect(await workflowDrift(dir, PROJECT, ["prod"])).toEqual([]);
  });

  /**
   * A declaration that cannot be turned into a stanza is reported, never thrown. `planAppWorkflows`
   * refuses a job with no `className` — and a check that let that escape would take `pithy doctor`'s
   * whole workflow block down to a `catch` and report nothing, which is the failure being fixed.
   */
  test("a job that cannot be bound at all is reported, not thrown", async () => {
    await worker("board", { env: { prod: {} } }, { digest: { binding: "DIGEST" } });

    const drift = await workflowDrift(dir, PROJECT, ["prod"]);
    expect(drift[0]?.fault).toBe("unwritable-declaration");
    expect(drift[0]?.reason).toContain("className");
  });

  /** A negative claim is only ever made against a config that was read. */
  test("a pithy.config.ts that will not import claims nothing", async () => {
    const workerDir = await worker("board", { env: { prod: {} } }, DIGEST);
    await writeFile(join(workerDir, "pithy.config.ts"), 'import "nothing-resolves-this";\n');

    expect(await workflowDrift(dir, PROJECT, ["prod"])).toEqual([]);
  });

  /** No app capability is no declaration, and `pithy worker sync` writes nothing for one. */
  test("a Worker with no app capability is not held to a declaration it does not have", async () => {
    await worker("board", { env: { prod: { workflows: [DIGEST_PROD] } } });

    expect(await workflowDrift(dir, PROJECT, ["prod"])).toEqual([]);
  });
});

describe("a library's adopter-hosted jobs are not drift", () => {
  /** `@pithy-sh/auth`'s purge, as `auth()` declares it: no class, optional, the daily pass on a cron. */
  const AUTH = `[{ name: "auth", requiredBindings: [], workflows: {
    purge: { binding: "AUTH_PURGE", optional: true },
    "purge-due": { binding: "AUTH_PURGE_DUE", schedule: "0 2 * * *", optional: true },
  } }]`;
  const PURGE = { binding: "AUTH_PURGE", name: "replay-prod-auth-purge", class_name: "AuthPurgeWorkflow" };

  test("the entries and cron the adopter wrote for them beside the app's own table are clean", async () => {
    await worker(
      "board",
      { env: { prod: { workflows: [DIGEST_PROD, PURGE], triggers: { crons: ["0 4 * * *", "0 2 * * *"] } } } },
      DIGEST,
      AUTH,
    );
    expect(await workflowDrift(dir, PROJECT, ["prod"])).toEqual([]);
  });

  test("and the app's own table is still held to its declaration beside them", async () => {
    await worker("board", { env: { prod: { workflows: [PURGE], triggers: { crons: ["0 2 * * *"] } } } }, DIGEST, AUTH);
    const [drift] = await workflowDrift(dir, PROJECT, ["prod"]);
    expect(drift).toMatchObject({
      fault: "unsynced-stanza",
      declared: { workflows: [DIGEST_PROD], crons: ["0 4 * * *"] },
      bound: { workflows: [], crons: [] },
    });
  });

  test("pithy worker sync keeps them, and the result is clean", async () => {
    const workerDir = await worker(
      "board",
      { env: { prod: { workflows: [PURGE], triggers: { crons: ["0 2 * * *"] } } } },
      DIGEST,
      AUTH,
    );
    const config = await composeFor("prod", async (load) => load(workerDir));
    if (!config.app) throw new Error("expected an app capability");
    await reconcileAppWorkflows({
      workerDir,
      project: PROJECT,
      app: config.app,
      capabilities: config.capabilities,
      env: "prod",
    });
    expect(await workflowDrift(dir, PROJECT, ["prod"])).toEqual([]);
  });
});

describe("describeWorkflowDrift", () => {
  test("names both sides of the comparison and the command that settles it", async () => {
    await worker("board", { env: { prod: {} } }, DIGEST);

    const sentence = describeWorkflowDrift((await workflowDrift(dir, PROJECT, ["prod"]))[0] as never);
    expect(sentence).toContain("DIGEST");
    expect(sentence).toContain("replay-prod-board-digest");
    expect(sentence).toContain("0 4 * * *");
    expect(sentence).toContain("env.prod binds nothing");
    expect(sentence).toContain("pithy worker sync");
  });

  /** No command can write a stanza for a job that cannot be named, so none is offered. */
  test("an unwritable declaration is sent to the config, not to a command", async () => {
    await worker("board", { env: { prod: {} } }, { digest: { binding: "DIGEST" } });

    const sentence = describeWorkflowDrift((await workflowDrift(dir, PROJECT, ["prod"]))[0] as never);
    expect(sentence).toContain("pithy.config.ts");
    expect(sentence).not.toContain("Run pithy worker sync");
  });
});

/** The same two branches, as `pithy doctor --json`'s `fix`: the sync for that Worker and environment, or none. */
describe("workflowDriftFix", () => {
  test("an unsynced stanza is the sync, narrowed to its Worker and environment", async () => {
    await worker("board", { env: { prod: {} } }, DIGEST);
    const [drift] = await workflowDrift(dir, PROJECT, ["prod"]);
    expect(workflowDriftFix(drift as never)).toBe("pithy worker sync --worker board --env prod");
  });

  test("an unwritable declaration has no command", async () => {
    await worker("board", { env: { prod: {} } }, { digest: { binding: "DIGEST" } });
    const [drift] = await workflowDrift(dir, PROJECT, ["prod"]);
    expect(workflowDriftFix(drift as never)).toBeNull();
  });
});

describe("assertWorkflowsBound", () => {
  test("refuses the deploy, naming the Worker and the command", async () => {
    await project();
    await worker("board", { env: { prod: {} } }, DIGEST);

    await expect(assertWorkflowsBound(dir, "prod")).rejects.toBeInstanceOf(PithyError);
    await expect(assertWorkflowsBound(dir, "prod")).rejects.toThrow(/board/);
    // The stanza is behind the declaration: a precondition, with the command doctor names for it.
    const failure = (await assertWorkflowsBound(dir, "prod").catch((error: unknown) => error)) as PithyError;
    expect(failure.payload.code).toBe("core/precondition_failed");
    expect(fixOf(failure)).toBe("pithy worker sync --worker board --env prod");
  });

  test("lets a synced environment through", async () => {
    await project();
    const workerDir = await worker("board", { env: { prod: {} } }, DIGEST);
    const app = { name: "board", workflows: DIGEST } as unknown as Parameters<typeof reconcileAppWorkflows>[0]["app"];
    await reconcileAppWorkflows({ workerDir, project: PROJECT, app, env: "prod" });

    await expect(assertWorkflowsBound(dir, "prod")).resolves.toBeUndefined();
  });

  /**
   * A feature environment's stanza is a generated build artifact under `.wrangler/`, not the tracked
   * `wrangler.jsonc` this reads and `pithy worker sync` writes — so holding it to a declaration no
   * command can write there would refuse every feature deploy. The same exemption, and the same
   * predicate, `assertOriginsDeclared` uses.
   */
  test("a feature environment is exempt", async () => {
    await project();
    await worker("board", { env: { prod: {} } }, DIGEST);

    await expect(assertWorkflowsBound(dir, "feature")).resolves.toBeUndefined();
  });

  /** With no readable project name nothing was established, and a deploy is not refused on nothing. */
  test("a project whose name cannot be read is not refused", async () => {
    await writeFile(join(dir, "pithy.config.ts"), "export default {};\n");
    await worker("board", { env: { prod: {} } }, DIGEST);

    await expect(assertWorkflowsBound(dir, "prod")).resolves.toBeUndefined();
  });
});

describe("checkWorkflows", () => {
  test("walks every environment the root config declares", async () => {
    await project('["staging", "prod"]');
    await worker("board", { env: { staging: {}, prod: {} } }, DIGEST);

    const check = await checkWorkflows(dir);
    expect(check.state).toBe("drifted");
    expect(check.drift.map((entry) => entry.env)).toEqual(["staging", "prod"]);
  });

  test("a synced project is ok", async () => {
    await project();
    const workerDir = await worker("board", { env: { staging: {}, prod: {} } }, DIGEST);
    const app = { name: "board", workflows: DIGEST } as unknown as Parameters<typeof reconcileAppWorkflows>[0]["app"];
    await reconcileAppWorkflows({ workerDir, project: PROJECT, app });

    expect(await checkWorkflows(dir)).toEqual({ state: "ok", drift: [] });
  });

  test("an unreadable root config could not be checked", async () => {
    await worker("board", { env: { prod: {} } }, DIGEST);

    expect(await checkWorkflows(dir)).toEqual({ state: "could-not-check", drift: [] });
  });
});

/**
 * **Each stanza is compared with its own environment's declaration.** An app may schedule a job differently per
 * environment, and the module cache holds whichever environment this process composed last, which must not decide.
 */
describe("an environment's declaration is read from its own composition", () => {
  test("the deploy gate and doctor's check each compare the environment they answer", async () => {
    await project('["staging", "prod"]');
    const stanza = (env: string, cron: string) => ({
      workflows: [{ binding: "DIGEST", name: `${PROJECT}-${env}-board-digest`, class_name: "DigestWorkflow" }],
      triggers: { crons: [cron] },
    });
    const workerDir = await worker("board", {
      env: { staging: stanza("staging", "0 1 * * *"), prod: stanza("prod", "0 2 * * *") },
    });
    await writeFile(
      join(workerDir, "pithy.config.ts"),
      [
        'const crons = { staging: "0 1 * * *", prod: "0 2 * * *" };',
        'const schedule = crons[process.env.ENVIRONMENT] ?? "0 9 * * *";',
        'export default { app: { name: "board", workflows: { digest: { binding: "DIGEST", className: "DigestWorkflow", schedule } } }, capabilities: [] };',
        "",
      ].join("\n"),
    );
    // What doctor's health block leaves in the module cache before this runs.
    await composeFor("dev", (load) => load(workerDir));

    await expect(assertWorkflowsBound(dir, "staging")).resolves.toBeUndefined();
    await expect(assertWorkflowsBound(dir, "prod")).resolves.toBeUndefined();
    expect(await checkWorkflows(dir)).toEqual({ state: "ok", drift: [] });
  });
});

/** The Worker's main module, at the path its `wrangler.jsonc` names. */
async function main(workerDir: string, source: string): Promise<void> {
  await mkdir(join(workerDir, "src"), { recursive: true });
  await writeFile(join(workerDir, "src", "index.ts"), source);
}

/** Two jobs, two classes: the shape a Worker exporting one and forgetting the other takes. */
const TWO_JOBS: Record<string, Job> = {
  digest: DIGEST.digest as Job,
  sweep: { binding: "SWEEP", className: "SweepWorkflow" },
};

describe("workflowExports", () => {
  test("a main exporting every declared class has nothing missing", async () => {
    const workerDir = await worker("board", { main: "src/index.ts", env: { prod: {} } }, TWO_JOBS);
    await main(
      workerDir,
      'export default {};\nexport class DigestWorkflow {}\nexport { SweepWorkflow } from "./sweep";\n',
    );

    expect(await workflowExports(workerDir, PROJECT, ["prod"])).toEqual({ state: "exported" });
  });

  test("names exactly the class main does not export", async () => {
    const workerDir = await worker("board", { main: "src/index.ts", env: { prod: {} } }, TWO_JOBS);
    await main(workerDir, "export default {};\nexport class DigestWorkflow {}\n");

    expect(await workflowExports(workerDir, PROJECT, ["prod"])).toEqual({
      state: "missing",
      main: "src/index.ts",
      missing: ["SweepWorkflow"],
    });
  });

  test("a class named in a comment or exported as a type only is still missing", async () => {
    const workerDir = await worker("board", { main: "src/index.ts", env: { prod: {} } }, DIGEST);
    await main(workerDir, '// export class DigestWorkflow {}\nexport type { DigestWorkflow } from "./digest";\n');

    expect(await workflowExports(workerDir, PROJECT, ["prod"])).toEqual({
      state: "missing",
      main: "src/index.ts",
      missing: ["DigestWorkflow"],
    });
  });

  test("a wrangler.jsonc naming no main is unreadable, not a missing export", async () => {
    const workerDir = await worker("board", { env: { prod: {} } }, DIGEST);

    const exports = await workflowExports(workerDir, PROJECT, ["prod"]);
    expect(exports.state).toBe("unreadable");
    expect(exports.state === "unreadable" && exports.reason).toContain("main");
  });

  test("a main that is not on disk is unreadable, and says which file", async () => {
    const workerDir = await worker("board", { main: "src/index.ts", env: { prod: {} } }, DIGEST);

    const exports = await workflowExports(workerDir, PROJECT, ["prod"]);
    expect(exports.state).toBe("unreadable");
    expect(exports.state === "unreadable" && exports.reason).toContain("src/index.ts");
  });

  test("a star re-export cannot establish a class is missing", async () => {
    const workerDir = await worker("board", { main: "src/index.ts", env: { prod: {} } }, DIGEST);
    await main(workerDir, 'export default {};\nexport * from "./workflows";\n');

    const exports = await workflowExports(workerDir, PROJECT, ["prod"]);
    expect(exports.state).toBe("unreadable");
    expect(exports.state === "unreadable" && exports.reason).toContain("export *");
  });

  test("a Worker declaring no Workflow reads no main", async () => {
    const workerDir = await worker("board", { env: { prod: {} } }, {});

    expect(await workflowExports(workerDir, PROJECT, ["prod"])).toEqual({ state: "exported" });
  });

  /**
   * One resolution with `checkWorkflows`: each environment's own composition. A class one environment declares
   * and another does not is still a class main must export, and the export check names the same set doctor's
   * drift declares.
   */
  test("asks after the classes checkWorkflows declares, environment by environment", async () => {
    await project('["staging", "prod"]');
    const workerDir = await worker("board", { main: "src/index.ts", env: { staging: {}, prod: {} } });
    await writeFile(
      join(workerDir, "pithy.config.ts"),
      [
        'const classes = { staging: "DigestWorkflow", prod: "DigestV2Workflow" };',
        'const className = classes[process.env.ENVIRONMENT] ?? "DevDigestWorkflow";',
        'export default { app: { name: "board", workflows: { digest: { binding: "DIGEST", className } } }, capabilities: [] };',
        "",
      ].join("\n"),
    );
    await main(workerDir, "export default {};\n");
    await composeFor("dev", (load) => load(workerDir));

    const check = await checkWorkflows(dir);
    const declared = [
      ...new Set(check.drift.flatMap((entry) => entry.declared.workflows.map((workflow) => workflow.class_name))),
    ];
    expect(declared).toEqual(["DigestWorkflow", "DigestV2Workflow"]);
    expect(await workflowExports(workerDir, PROJECT, ["staging", "prod"])).toEqual({
      state: "missing",
      main: "src/index.ts",
      missing: declared,
    });
  });
});
