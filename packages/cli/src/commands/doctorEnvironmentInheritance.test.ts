// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkEnvironmentInheritance } from "../doctor/environmentInheritance";
import { scaffoldProject } from "../project/scaffold";
import { scaffoldWorker } from "../project/workerScaffold";
import { readWranglerConfig } from "../project/wrangler";
import { NOT_INHERITED_BY_ENVIRONMENTS } from "../project/wranglerInheritance";
import { doctorHarness } from "../test-utils/doctorHarness";
import { buildDoctorReport, doctorExitCode, renderDoctorJson, renderDoctorText } from "./doctor";

/**
 * **The starter must pass the check it teaches** (#581), and the check must not gate the exit.
 *
 * The project is scaffolded by the real `scaffoldProject` against the real template rather than written
 * out here, because the template is the artifact under test: a fixture shaped to pass would certify
 * nothing but itself, and the fault this issue is about arrived in an adopter's config by being copied
 * out of exactly this file.
 */

const harness = doctorHarness();
const { baseOptions } = harness;

/** A project on disk, scaffolded the way `pithy init` scaffolds one. */
async function scaffolded(environments?: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pithy-inherit-scaffold-"));
  await scaffoldProject({
    targetDir: dir,
    appName: "acme",
    worker: "api",
    ...(environments ? { environments } : {}),
  });
  return dir;
}

describe("the scaffolded project", () => {
  test("passes on the environments the template ships", async () => {
    expect(await checkEnvironmentInheritance(await scaffolded())).toEqual({ state: "ok", unrepeated: [] });
  });

  test("passes on a declared set the template does not ship, where the stanzas are rewritten", async () => {
    // The other half of the scaffolder: a custom set makes `stampEnvironmentStanzas` rebuild every stanza
    // from scratch, and a rebuild that drops a non-inherited key is the same fault the template had.
    expect(await checkEnvironmentInheritance(await scaffolded(["staging", "live", "prod"]))).toEqual({
      state: "ok",
      unrepeated: [],
    });
  });

  test("each rewritten stanza carries the top level's non-inherited keys, by value", async () => {
    const dir = await scaffolded(["live"]);
    const config = (await readWranglerConfig(join(dir, "apps", "api"))) as Record<string, unknown> & {
      env: Record<string, Record<string, unknown>>;
    };
    const stanza = config.env.live as Record<string, unknown>;
    // Stated as the invariant rather than as a list of key names: whatever the top level declares that an
    // environment does not inherit, the stanza has. A list here would be a third copy of the declaration.
    for (const key of NOT_INHERITED_BY_ENVIRONMENTS) {
      const top = config[key];
      const declares = Array.isArray(top) ? top.length > 0 : typeof top === "object" && top !== null;
      if (declares) expect(stanza[key], `env.live does not repeat ${key}`).toBeDefined();
    }
    // And the one the kit's first adopter lost, by name — the regression #581 was opened for.
    expect(stanza.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    // `vars` is the environment's own, not a copy of dev's: repeating is not the same as duplicating.
    expect((stanza.vars as Record<string, string>).ENVIRONMENT).toBe("live");
  });

  test("a second Worker added to it passes too", async () => {
    // The reach check. `pithy init` is not the only thing in the kit that writes an env stanza, and a
    // check the kit's own `pithy worker add` fails on a fresh project is a check that teaches adopters
    // to ignore the block. Every producer of a stanza is held to the rule, not just the first.
    const dir = await scaffolded();
    await scaffoldWorker({ projectDir: dir, name: "admin", project: "acme" });
    expect(await checkEnvironmentInheritance(dir)).toEqual({ state: "ok", unrepeated: [] });
  });
});

describe("the report", () => {
  const finding = {
    state: "unrepeated" as const,
    unrepeated: [
      { worker: "api", env: "staging", key: "version_metadata", carries: ["CF_VERSION_METADATA"] },
      { worker: "api", env: "prod", key: "vars", carries: ["ENVIRONMENT", "PROJECT"] },
    ],
  };

  test("prints the block, naming the key, the environment and the cost", async () => {
    const report = await buildDoctorReport(baseOptions({ checkEnvironmentInheritance: async () => finding }));
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Environment inheritance:");
    expect(text).toContain("api: version_metadata is at the top level and not in env.staging");
    expect(text).toContain("staging deploys without CF_VERSION_METADATA");
    expect(text).toContain("prod deploys without ENVIRONMENT, PROJECT");
  });

  test("reports and never gates the exit", async () => {
    // The decision, held as behavior. Every project scaffolded before this landed is in violation for
    // `version_metadata`, and an upgrade that turns a green `pithy doctor` red in CI is a surprise.
    const report = await buildDoctorReport(baseOptions({ checkEnvironmentInheritance: async () => finding }));
    expect(doctorExitCode(report)).toBe(0);
  });

  test("says nothing when every stanza repeats what it must", async () => {
    const report = await buildDoctorReport(
      baseOptions({ checkEnvironmentInheritance: async () => ({ state: "ok", unrepeated: [] }) }),
    );
    expect(renderDoctorText(report, "/home/u")).not.toContain("Environment inheritance:");
  });

  test("carries each finding's own sentence in --json", async () => {
    const report = await buildDoctorReport(baseOptions({ checkEnvironmentInheritance: async () => finding }));
    const payload = renderDoctorJson(report) as unknown as {
      environmentInheritance: { state: string; unrepeated: { key: string; detail: string }[] };
    };
    expect(payload.environmentInheritance.state).toBe("unrepeated");
    expect(payload.environmentInheritance.unrepeated[0]?.detail).toContain("CF_VERSION_METADATA");
  });
});
