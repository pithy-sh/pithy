// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_WORKER, scaffoldProject } from "../project/scaffold";
import { applyReconcilePlan, buildReconcilePlan } from "./reconcile";

/**
 * A generated binding value the kit has since changed its mind about, over a real scaffolded project
 * (#499).
 *
 * **The whole finding is a comparison, so a fabricated plan cannot make it.** What went wrong was that a
 * limiter's `namespace_id` was written once at `pithy add` and never revisited, and the only way anyone
 * could see it was to scaffold a second project and diff. So every case here writes the stanza with the
 * real writer, edits it the way an older project already differs, and asks the real plan what it sees.
 *
 * The first test is the one that makes the rest mean anything: what this kit writes today must compare
 * clean, or the report fires on every project and says nothing about any of them.
 */

/** A capability whose rate limiter is the thing under test, plus a required D1 the comparison must ignore. */
const LIMITED = CapabilityManifest.parse({
  name: "limited",
  package: "@pithy-sh/limited",
  requiredBindings: [
    { type: "d1", name: "DB" },
    { type: "ratelimit", name: "AUTH_RATE_LIMITER" },
  ],
});

/** The same limiter, declared optional — so a Worker can decline it and the comparison must let it go. */
const LIMITED_OPTIONAL = CapabilityManifest.parse({
  name: "limited",
  package: "@pithy-sh/limited",
  requiredBindings: [
    { type: "d1", name: "DB" },
    { type: "ratelimit", name: "AUTH_RATE_LIMITER", optional: true },
  ],
});

/** What the FNV-1a derivation answers for that binding, and what a positional counter left behind. */
const DERIVED = "3093";
const POSITIONAL = "1001";

describe("a generated binding value the kit would now write differently", () => {
  let dir: string;
  let worker: string;

  /** The composed instance as `createBackend` derives it — every declared binding, optional ones included. */
  const composedFrom = (manifest: CapabilityManifest) => [
    { name: manifest.name, requiredBindings: manifest.requiredBindings },
  ];

  async function writeManifest(manifest: CapabilityManifest): Promise<void> {
    const pkgDir = join(dir, "node_modules", "@pithy-sh", manifest.name);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "pithy.manifest.json"), JSON.stringify(manifest));
  }

  /** Write the capability's bindings into the Worker the way `pithy upgrade` does. */
  async function writeBindings(manifest: CapabilityManifest): Promise<void> {
    const capabilities = composedFrom(manifest);
    const plan = await buildReconcilePlan({
      account: null,
      projectDir: dir,
      workerDir: worker,
      env: "dev",
      capabilities,
      workerConfig: { capabilities: [] } as never,
    });
    await applyReconcilePlan({
      account: null,
      projectDir: dir,
      workerDir: worker,
      env: "dev",
      plan,
      capabilities,
      migrate: false,
    });
  }

  /** Read the plan back, with whatever this Worker's `pithy.config.ts` is being said to declare. */
  async function plan(manifest: CapabilityManifest, workerConfig: Record<string, unknown> = {}) {
    return buildReconcilePlan({
      account: null,
      projectDir: dir,
      workerDir: worker,
      env: "dev",
      capabilities: composedFrom(manifest),
      workerConfig: { capabilities: [], ...workerConfig } as never,
    });
  }

  /** Age the project: rewrite every limiter id to the one a positional counter produced. */
  async function ageTheLimiter(): Promise<void> {
    const path = join(worker, "wrangler.jsonc");
    const before = await readFile(path, "utf8");
    if (!before.includes(`"${DERIVED}"`)) throw new Error("nothing wrote the derived id — the fixture is broken");
    await writeFile(path, before.replaceAll(`"${DERIVED}"`, `"${POSITIONAL}"`));
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-generated-"));
    await scaffoldProject({ targetDir: dir, appName: "generated" });
    worker = join(dir, "apps", DEFAULT_WORKER);
    await writeManifest(LIMITED);
    await writeBindings(LIMITED);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("what this kit writes today compares clean, in every environment", async () => {
    // The anti-vacuity guard for the file. Without it, every assertion below would pass on a comparison
    // that reports every project ever scaffolded.
    expect((await plan(LIMITED)).generatedValues).toEqual({ state: "read", drift: [], stalePins: [] });
  });

  test("an older project's id is reported with both numbers and every environment it is in", async () => {
    await ageTheLimiter();
    const values = (await plan(LIMITED)).generatedValues;
    expect(values.state === "read" && values.drift).toEqual([
      {
        name: "AUTH_RATE_LIMITER",
        type: "ratelimit",
        field: "namespace_id",
        expected: DERIVED,
        actual: POSITIONAL,
        envs: ["dev", "staging", "prod"],
        pinnedReason: null,
      },
    ]);
  });

  test("nothing rewrites it — an upgrade over the same project leaves the adopter's id alone", async () => {
    // The half of the design that is a refusal. A `namespace_id` is a live budget's identity, so an
    // upgrade that quietly corrected one would re-partition a counter under running traffic.
    await ageTheLimiter();
    await writeBindings(LIMITED);
    expect(await readFile(join(worker, "wrangler.jsonc"), "utf8")).toContain(`"${POSITIONAL}"`);
  });

  test("a pin carries the adopter's reason and stops the difference reading as a finding", async () => {
    await ageTheLimiter();
    const values = (await plan(LIMITED, { pinnedBindings: { AUTH_RATE_LIMITER: "our budget, tuned" } }))
      .generatedValues;
    expect(values.state === "read" && values.drift[0]?.pinnedReason).toBe("our budget, tuned");
    expect(values.state === "read" && values.stalePins).toEqual([]);
  });

  test("a pin on a value that matches is stale, and says so rather than disappearing", async () => {
    // What accepting the kit's value leaves behind. Reported for the reason an unrecognized decline is:
    // a pin nobody clears is a line the next person has to work out for themselves.
    const values = (await plan(LIMITED, { pinnedBindings: { AUTH_RATE_LIMITER: "our budget, tuned" } }))
      .generatedValues;
    expect(values.state === "read" && values.drift).toEqual([]);
    expect(values.state === "read" && values.stalePins).toEqual([
      { name: "AUTH_RATE_LIMITER", reason: "our budget, tuned" },
    ]);
  });

  test("a pin naming a binding nothing composes is stale too", async () => {
    const values = (await plan(LIMITED, { pinnedBindings: { NOT_A_BINDING: "kept on purpose" } })).generatedValues;
    expect(values.state === "read" && values.stalePins).toEqual([{ name: "NOT_A_BINDING", reason: "kept on purpose" }]);
  });

  test("a declaration that will not parse is reported, and the rest of the plan still stands", async () => {
    await ageTheLimiter();
    const built = await plan(LIMITED, { pinnedBindings: { AUTH_RATE_LIMITER: "" } });
    expect(built.generatedValues.state).toBe("invalid");
    // The plan's other contributors are unaffected — one malformed declaration must not cost the report.
    expect(built.declinedBindings).toEqual({ state: "read", declines: [] });
    expect(built.worker).toBeTruthy();
  });

  test("a declined binding is not compared, because nothing is meant to be writing it", async () => {
    await writeManifest(LIMITED_OPTIONAL);
    await ageTheLimiter();
    const values = (await plan(LIMITED_OPTIONAL, { declinedBindings: { AUTH_RATE_LIMITER: "we rate limit upstream" } }))
      .generatedValues;
    expect(values.state === "read" && values.drift).toEqual([]);
  });

  test("a limiter no capability declares is the adopter's own, and is never reported", async () => {
    // Walking `ratelimits` directly would be shorter and would report this one. The kit never wrote it
    // and has no opinion about it.
    const path = join(worker, "wrangler.jsonc");
    const before = await readFile(path, "utf8");
    await writeFile(
      path,
      before.replace(
        `"ratelimits": [`,
        `"ratelimits": [\n    { "name": "OUR_OWN_LIMITER", "namespace_id": "77", "simple": { "limit": 5, "period": 10 } },`,
      ),
    );
    const values = (await plan(LIMITED)).generatedValues;
    expect(values.state === "read" && values.drift).toEqual([]);
  });
});
