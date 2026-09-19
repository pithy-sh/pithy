// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildDoctorReport, doctorExitCode, renderDoctorJson, renderDoctorText } from "../commands/doctor";
import { checkFeatureRatelimitIds } from "../doctor/featureRatelimitIds";
import { provisionEnvironment } from "../provision/environment";
import type { ResourceProvisioners } from "../provision/resources";
import { doctorHarness } from "../test-utils/doctorHarness";
import { assertProjectDeclaresNoFeatureIds } from "./ratelimits";

/**
 * **The feature rate-limit range is reserved in every project, not only in one that provisions features (#643).**
 *
 * The reviewer's case of the review of 4828e1fc: project `other` never provisions a feature and declares
 * `namespace_id` `1031275746` for production. Project `acme`'s `feature/12-c` was allocated `1031275746` in the
 * same account, and the two shared counters. The range was guarded only by `provision --feature`, against the
 * provisioning project's own configs. Now `provision` for any environment, `deploy`, and `doctor` read every
 * Worker's tracked config in every project, and the id is read as the integer it spells.
 */

const harness = doctorHarness();

describe.each([
  ["1031275746", "1031275746"],
  ["01031275746", '"01031275746" (1031275746)'],
])("a project declaring %s, which never provisions a feature", (id, named) => {
  let dir: string;
  let workerDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pithy-range-"));
    workerDir = join(dir, "apps", "api");
    await mkdir(workerDir, { recursive: true });
    const limiter = { name: "LIMIT", namespace_id: id, simple: { limit: 10, period: 60 } };
    await writeFile(
      join(workerDir, "wrangler.jsonc"),
      JSON.stringify({ name: "other-api", ratelimits: [limiter], env: { prod: { ratelimits: [limiter] } } }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("pithy provision --env prod refuses it before creating anything", async () => {
    const created: string[] = [];
    const recording = {
      find: async () => null,
      create: async (name: string) => {
        created.push(name);
        return { id: name };
      },
      delete: async () => {},
    };
    await expect(
      provisionEnvironment({
        projectDir: dir,
        scope: environmentScope("other", "prod"),
        capabilities: [],
        provisioners: { d1: recording, kv: recording, r2: recording } as unknown as ResourceProvisioners,
        seedData: false,
        administersItself: false,
        resolveWorkers: async () => [{ name: "other-api", dir: workerDir, capabilities: [] }],
        migrate: async () => {},
        seed: async () => {},
      }),
    ).rejects.toThrow(`other-api declares rate-limit namespace ${named} in the top level.`);
    expect(created).toEqual([]);
  });

  test("pithy deploy refuses it", async () => {
    await expect(assertProjectDeclaresNoFeatureIds(dir)).rejects.toThrow(
      "Namespaces 1000000000 through 1999999999 are reserved for features.",
    );
  });

  test("pithy doctor reports it, in every stanza, and fails the run", async () => {
    const check = await checkFeatureRatelimitIds(dir);
    expect(check).toEqual({
      state: "reserved",
      findings: [
        `other-api declares rate-limit namespace ${named} in the top level.`,
        `other-api declares rate-limit namespace ${named} in env.prod.`,
      ],
    });
    const report = await buildDoctorReport(harness.healthyOptions({ checkFeatureRatelimitIds: async () => check }));
    expect(doctorExitCode(report)).toBe(1);
    expect(renderDoctorText(report, "/home/u")).toContain("Rate limiters:");
    expect(renderDoctorJson(report).featureRatelimitIds).toEqual(check);
  });
});

describe("an id below the range", () => {
  test("is not refused, and doctor says nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pithy-range-"));
    try {
      await mkdir(join(dir, "apps", "api"), { recursive: true });
      await writeFile(
        join(dir, "apps", "api", "wrangler.jsonc"),
        JSON.stringify({ name: "acme-api", ratelimits: [{ name: "L", namespace_id: "3093" }] }),
      );
      await expect(assertProjectDeclaresNoFeatureIds(dir)).resolves.toBeUndefined();
      expect(await checkFeatureRatelimitIds(dir)).toEqual({ state: "ok", findings: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
