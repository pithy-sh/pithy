// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Capability, defineCapability } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { type FeatureIdentity, isFeatureOwnedName } from "@pithy-sh/core/src/naming/feature";
import { featureScope } from "@pithy-sh/core/src/naming/provisionScope";
import { parse } from "comment-json";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { planAppWorkflows, reconcileAppWorkflows, unhostableAppJobs } from "./appWorkflows";

/**
 * Workflows the adopter's **own app capability** declares.
 *
 * A library capability's Workflows are provisioned: `pithy <capability> provision` deploys the host and
 * writes the binding. The app's had no path at all, so the `workflows` array, the cron schedule, and the
 * per-environment binding table were hand-written — each having to match `<project>-<env>-<capability>-<job>`
 * and Cloudflare's segment rule, both of which fail at deploy rather than at the point of writing.
 */

/** The dashboard's real shape, reduced: a rotation job on a daily sweep, plus one dispatch-only job. */
function appCapability(): Capability {
  return defineCapability({
    name: "dashboard",
    requiredBindings: [],
    workflows: {
      "key-rotation": {
        binding: "KEY_ROTATION",
        params: z.object({}),
        className: "KeyRotationWorkflow",
        schedule: "0 3 * * *",
      },
      reindex: {
        binding: "REINDEX",
        params: z.object({}),
        className: "ReindexWorkflow",
      },
    },
  });
}

/** The project every derived name leads with — `requireProjectName`'s answer, never a guess. */
const PROJECT = "acme";

/** The wrangler slice these tests read back. */
interface Stanza {
  workflows?: { binding: string; name?: string; class_name?: string; script_name?: string }[];
  triggers?: { crons?: string[] };
}
interface Wrangler extends Stanza {
  env?: Record<string, Stanza | undefined>;
}

const fixture = `{
  "name": "pithy-app",
  "main": "src/index.ts",

  // The app database. Every capability shares it.
  "d1_databases": [{ "binding": "DB" }],

  "env": {
    "staging": {
      "d1_databases": [{ "binding": "DB" }]
    },
    "prod": {
      "d1_databases": [{ "binding": "DB" }]
    }
  }
}
`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-appworkflows-"));
  await writeFile(join(dir, "wrangler.jsonc"), fixture);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = async (): Promise<Wrangler> =>
  parse(await readFile(join(dir, "wrangler.jsonc"), "utf8")) as unknown as Wrangler;

describe("planAppWorkflows", () => {
  test("derives the kit's own name and carries no script_name — the class is in the app's own main", () => {
    expect(planAppWorkflows(appCapability(), { project: PROJECT, env: "staging" })).toEqual({
      workflows: [
        { binding: "KEY_ROTATION", name: "acme-staging-dashboard-key-rotation", class_name: "KeyRotationWorkflow" },
        { binding: "REINDEX", name: "acme-staging-dashboard-reindex", class_name: "ReindexWorkflow" },
      ],
      crons: ["0 3 * * *"],
    });
  });

  test("the names are environment-scoped, which is the whole per-environment table by hand", () => {
    const staging = planAppWorkflows(appCapability(), { project: PROJECT, env: "staging" });
    const prod = planAppWorkflows(appCapability(), { project: PROJECT, env: "prod" });
    expect(staging.workflows[0]?.name).not.toBe(prod.workflows[0]?.name);
  });

  /**
   * **A feature is an environment, and the app's own Workflows take its names (#650).**
   *
   * `<project>-feature-<capability>-<job>` would be one Workflow every open branch deployed over every
   * other's — Workflow names are account-wide. The feature's own head is what `featureScope.workflowHost`
   * carries, so the one derivation composes it for a feature exactly as it does for staging.
   */
  test("a feature's names are the feature's own, and parse back to it", () => {
    const identity: FeatureIdentity = { project: PROJECT, issue: "69", slug: "demo" };
    const plan = planAppWorkflows(appCapability(), featureScope(identity).workflowHost);
    expect(plan.workflows).toEqual([
      { binding: "KEY_ROTATION", name: "acme-f69-demo--dashboard-key-rotation", class_name: "KeyRotationWorkflow" },
      { binding: "REINDEX", name: "acme-f69-demo--dashboard-reindex", class_name: "ReindexWorkflow" },
    ]);
    // Owned, not merely prefixed: parsed back to this project, issue and slug, which is what teardown asks.
    for (const entry of plan.workflows) expect(isFeatureOwnedName(identity, entry.name)).toBe(true);
  });

  test("two branches of one issue never compose one Workflow name", () => {
    const one = planAppWorkflows(
      appCapability(),
      featureScope({ project: PROJECT, issue: "69", slug: "a" }).workflowHost,
    );
    const two = planAppWorkflows(
      appCapability(),
      featureScope({ project: PROJECT, issue: "69", slug: "b" }).workflowHost,
    );
    expect(one.workflows[0]?.name).not.toBe(two.workflows[0]?.name);
  });

  /**
   * A feature name is never truncated: a fitted slug was a short hash, and a hash is a slug some sibling branch
   * can have whole. So a name that does not fit is refused here, at the derivation, rather than deployed under a
   * string two features could compose. `assertFeatureSlugFits` says it once for the whole branch; this is the
   * backstop behind it.
   */
  test("a name that will not fit the Workflow limit is refused, never truncated", () => {
    expect(() =>
      planAppWorkflows(
        appCapability(),
        featureScope({ project: PROJECT, issue: "69", slug: "a".repeat(40) }).workflowHost,
      ),
    ).toThrow(PithyError);
  });

  test("a capability with no workflows plans nothing", () => {
    const bare = defineCapability({ name: "dashboard", requiredBindings: [] });
    expect(planAppWorkflows(bare, { project: PROJECT, env: "dev" })).toEqual({ workflows: [], crons: [] });
  });

  test("a job with no className is refused here, not at deploy", () => {
    const classless = defineCapability({
      name: "dashboard",
      requiredBindings: [],
      workflows: { sweep: { binding: "SWEEP", params: z.object({}) } },
    });
    expect(() => planAppWorkflows(classless, { project: PROJECT, env: "dev" })).toThrow(PithyError);
  });
});

/**
 * **The preflight and the writer must mean one thing by "cannot be hosted" (#650 review).**
 *
 * `feature/provision.ts` asks this before a feature run creates anything; `planAppWorkflows` refuses the same
 * declaration when the stanza is written. Two readings of one rule is a branch that passes the preflight and
 * then throws with its resources already on the account — the exact defect the preflight exists to close — so
 * the two are held together here rather than each tested alone.
 */
describe("unhostableAppJobs", () => {
  test("names the job planAppWorkflows refuses, and nothing else", () => {
    const mixed = defineCapability({
      name: "dashboard",
      requiredBindings: [],
      workflows: {
        rotate: { binding: "ROTATE", params: z.object({}), className: "Rotate" },
        sweep: { binding: "SWEEP", params: z.object({}) },
      },
    });
    expect(unhostableAppJobs(mixed)).toEqual(["dashboard/sweep"]);
    expect(() => planAppWorkflows(mixed, { project: PROJECT, env: "staging" })).toThrow(PithyError);
  });

  test("and an app whose jobs all declare a class names none, and plans", () => {
    expect(unhostableAppJobs(appCapability())).toEqual([]);
    expect(() => planAppWorkflows(appCapability(), { project: PROJECT, env: "staging" })).not.toThrow();
  });

  test("an app with no workflows at all names none", () => {
    expect(unhostableAppJobs(defineCapability({ name: "dashboard", requiredBindings: [] }))).toEqual([]);
  });
});

describe("reconcileAppWorkflows", () => {
  test("writes every declared environment's table, dev at the top level", async () => {
    const runs = await reconcileAppWorkflows({ workerDir: dir, project: PROJECT, app: appCapability() });

    expect(runs.map((run) => [run.env, run.changed])).toEqual([
      ["dev", true],
      ["staging", true],
      ["prod", true],
    ]);
    // The report is what was written, so `--json` and the file cannot disagree.
    expect(runs[1]?.workflows).toEqual([
      { binding: "KEY_ROTATION", name: "acme-staging-dashboard-key-rotation", class_name: "KeyRotationWorkflow" },
      { binding: "REINDEX", name: "acme-staging-dashboard-reindex", class_name: "ReindexWorkflow" },
    ]);
    const config = await read();
    expect(config.workflows?.map((entry) => entry.name)).toEqual([
      "acme-dev-dashboard-key-rotation",
      "acme-dev-dashboard-reindex",
    ]);
    expect(config.triggers?.crons).toEqual(["0 3 * * *"]);
    expect(config.env?.prod?.workflows?.map((entry) => entry.name)).toEqual([
      "acme-prod-dashboard-key-rotation",
      "acme-prod-dashboard-reindex",
    ]);
    expect(config.env?.staging?.triggers?.crons).toEqual(["0 3 * * *"]);
  });

  test("--env narrows to one environment and leaves the rest alone", async () => {
    await reconcileAppWorkflows({ workerDir: dir, project: PROJECT, app: appCapability(), env: "staging" });

    const config = await read();
    expect(config.env?.staging?.workflows).toHaveLength(2);
    expect(config.workflows).toBeUndefined();
    expect(config.env?.prod?.workflows).toBeUndefined();
  });

  test("is idempotent, reports it, and keeps the adopter's comments", async () => {
    await reconcileAppWorkflows({ workerDir: dir, project: PROJECT, app: appCapability() });
    const once = await readFile(join(dir, "wrangler.jsonc"), "utf8");

    const again = await reconcileAppWorkflows({ workerDir: dir, project: PROJECT, app: appCapability() });

    expect(again.every((run) => run.changed)).toBe(false);
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(once);
    expect(once).toContain("// The app database. Every capability shares it.");
  });

  test("a renamed job replaces the stale entry — reconcile, not append", async () => {
    await reconcileAppWorkflows({ workerDir: dir, project: PROJECT, app: appCapability(), env: "staging" });

    const renamed = defineCapability({
      name: "dashboard",
      requiredBindings: [],
      workflows: {
        "key-rotation": {
          binding: "KEY_ROTATION",
          params: z.object({}),
          className: "KeyRotationWorkflow",
          schedule: "0 4 * * *",
        },
      },
    });
    await reconcileAppWorkflows({ workerDir: dir, project: PROJECT, app: renamed, env: "staging" });

    const stanza = (await read()).env?.staging;
    expect(stanza?.workflows?.map((entry) => entry.binding)).toEqual(["KEY_ROTATION"]);
    // The old schedule is gone, not merely joined: one `scheduled` handler fires every job on any tick,
    // so a cron nobody declares is a run nobody asked for.
    expect(stanza?.triggers?.crons).toEqual(["0 4 * * *"]);
  });

  test("dropping the last schedule writes an empty cron list, not an absent key", async () => {
    await reconcileAppWorkflows({ workerDir: dir, project: PROJECT, app: appCapability(), env: "staging" });

    const unscheduled = defineCapability({
      name: "dashboard",
      requiredBindings: [],
      workflows: {
        "key-rotation": { binding: "KEY_ROTATION", params: z.object({}), className: "KeyRotationWorkflow" },
      },
    });
    await reconcileAppWorkflows({ workerDir: dir, project: PROJECT, app: unscheduled, env: "staging" });

    // Wrangler reads an absent `crons` as "not declared" and leaves the deployed schedule alone, so a
    // deleted key would leave yesterday's cron still firing the job that is left.
    expect((await read()).env?.staging?.triggers?.crons).toEqual([]);
  });

  test("an app with no schedule at all gets no triggers block — nothing invented", async () => {
    const unscheduled = defineCapability({
      name: "dashboard",
      requiredBindings: [],
      workflows: { reindex: { binding: "REINDEX", params: z.object({}), className: "ReindexWorkflow" } },
    });

    await reconcileAppWorkflows({ workerDir: dir, project: PROJECT, app: unscheduled, env: "staging" });

    expect((await read()).env?.staging?.triggers).toBeUndefined();
  });

  test("a library capability's provisioned entry survives — it is bound to another script", async () => {
    await writeFile(
      join(dir, "wrangler.jsonc"),
      `{
  "name": "pithy-app",
  "main": "src/index.ts",
  "env": {
    "staging": {
      "workflows": [
        {
          "binding": "STORAGE_SWEEP",
          "name": "acme-staging-storage-sweep",
          "class_name": "StorageSweepWorkflow",
          "script_name": "acme-staging-storage"
        }
      ]
    }
  }
}
`,
    );

    await reconcileAppWorkflows({ workerDir: dir, project: PROJECT, app: appCapability(), env: "staging" });

    const bindings = (await read()).env?.staging?.workflows?.map((entry) => entry.binding);
    expect(bindings).toEqual(["STORAGE_SWEEP", "KEY_ROTATION", "REINDEX"]);
  });

  test("an app that declares no workflows writes nothing at all", async () => {
    const bare = defineCapability({ name: "dashboard", requiredBindings: [] });
    const runs = await reconcileAppWorkflows({ workerDir: dir, project: PROJECT, app: bare });

    // Reconciled — the empty declaration is a declaration — and nothing moved, so nothing was written.
    // No empty `workflows` key, which wrangler would read as one, and no `triggers` block invented.
    expect(runs.every((run) => !run.changed)).toBe(true);
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(fixture);
  });

  /**
   * The last job dropped from `pithy.config.ts`. This used to return before the file was opened, so the
   * binding and the cron stayed behind with no command that would remove them — and #267's reader would
   * have reported a fault naming `pithy worker sync`, which was the one thing that could not fix it.
   */
  test("dropping the last job takes its binding and its cron out", async () => {
    await reconcileAppWorkflows({ workerDir: dir, project: PROJECT, app: appCapability(), env: "staging" });

    const bare = defineCapability({ name: "dashboard", requiredBindings: [] });
    const runs = await reconcileAppWorkflows({ workerDir: dir, project: PROJECT, app: bare, env: "staging" });

    expect(runs[0]?.changed).toBe(true);
    expect((await read()).env?.staging?.workflows).toEqual([]);
    expect((await read()).env?.staging?.triggers?.crons).toEqual([]);
  });

  test("refuses when a hand-edited entry already lacks a field wrangler requires", async () => {
    await writeFile(
      join(dir, "wrangler.jsonc"),
      `{
  "name": "pithy-app",
  "main": "src/index.ts",
  "env": { "staging": { "vectorize": [{ "binding": "LEGACY" }] } }
}
`,
    );
    const before = await readFile(join(dir, "wrangler.jsonc"), "utf8");

    await expect(
      reconcileAppWorkflows({ workerDir: dir, project: PROJECT, app: appCapability(), env: "staging" }),
    ).rejects.toBeInstanceOf(PithyError);
    expect(await readFile(join(dir, "wrangler.jsonc"), "utf8")).toBe(before);
  });
});
