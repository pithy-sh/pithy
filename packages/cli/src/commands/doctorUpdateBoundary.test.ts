// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { doctorHarness, registryFetch } from "../test-utils/doctorHarness";
import { buildDoctorReport, renderDoctorText } from "./doctor";

/** `pithy doctor`'s update advice when the newest kit release crosses a breaking boundary. */

const h = doctorHarness();

const cliSpec = (spec: string) => async () => [
  { name: "@pithy-sh/cli", manifest: "package.json", field: "devDependencies" as const, spec },
];

/** A CLI run from the project's own `node_modules`, at `version`. */
async function projectCli(version: string): Promise<string> {
  const bin = join(h.dir, "node_modules", ".bun", `@pithy-sh+cli@${version}`, "node_modules", "@pithy-sh", "cli");
  await mkdir(join(bin, "dist"), { recursive: true });
  await writeFile(join(bin, "dist", "bin.js"), "");
  return join(bin, "dist", "bin.js");
}

describe("pithy doctor — the CLI's update across a breaking boundary", () => {
  test("a new 0.x minor past the project's range: --latest, and the boundary is said", async () => {
    const report = await buildDoctorReport(
      h.baseOptions({
        installedVersion: "0.24.2",
        argv1: await projectCli("0.24.2"),
        fetch: registryFetch({ cli: "0.25.0" }),
        declaredSpecs: cliSpec("^0.24.2"),
      }),
    );
    expect(report.cli.upgradeCommand).toBe("pithy upgrade --packages --latest");
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Update available: 0.25.0. Crosses a breaking boundary.");
    expect(text).toContain("Run: pithy upgrade --packages --latest");
  });

  test("an update inside the range names --packages and no boundary", async () => {
    const report = await buildDoctorReport(
      h.baseOptions({
        installedVersion: "0.24.1",
        argv1: await projectCli("0.24.1"),
        fetch: registryFetch({ cli: "0.24.2" }),
        declaredSpecs: cliSpec("^0.24.1"),
      }),
    );
    const text = renderDoctorText(report, "/home/u");
    expect(text).toContain("Update available: 0.24.2\n");
    expect(text).toContain("Run: pithy upgrade --packages\n");
  });

  test("a capability whose newest release crosses the boundary names --latest", async () => {
    const report = await buildDoctorReport(
      h.baseOptions({
        fetch: registryFetch({ cli: "1.2.0", core: "0.21.0" }),
        installedCapabilities: async () => [{ name: "@pithy-sh/core", version: "0.20.1" }],
        declaredSpecs: async () => [
          { name: "@pithy-sh/core", manifest: "package.json", field: "dependencies" as const, spec: "^0.20.1" },
        ],
      }),
    );
    expect(report.project?.capabilities[0]).toMatchObject({ command: "pithy upgrade --packages --latest" });
    expect(renderDoctorText(report, "/home/u")).toContain(
      "  @pithy-sh/core  0.20.1 (0.21.0 available — run `pithy upgrade --packages --latest`. Crosses a breaking boundary.)",
    );
  });
});
