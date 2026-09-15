// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildDoctorReport, type DoctorReportOptions } from "../commands/doctor";
import { doctorHarness } from "../test-utils/doctorHarness";

/**
 * **`Origins:`, `Workflows:` and the settings check's origins answer each environment from its own
 * composition (#586).**
 *
 * The health block composes each Worker once per environment. These three sections read the Worker's
 * config again on their own, through a loader that took the module cache, so each got whichever
 * environment the health block happened to compose last and printed it under every heading. Reproduced
 * with the real CLI: a Worker whose `domains` names the environment it was composed for printed dev's
 * host under staging and prod, and doctor exited 1 over a project that was correct.
 *
 * The fixture is a real project whose Worker config reads `ENVIRONMENT` at module scope and declares a
 * different domain, cron and settings finding in each one, in each of two Workers, with a `wrangler.jsonc` that serves exactly
 * what each environment's own composition names. So a section that answered from another environment's
 * composition, or from none, reports drift here; one that answered from its own reports none.
 *
 * What it does not see: a module the config imports that reads the environment keeps its first answer,
 * which is the primitive's stated limit (`project/composeFor.ts`). Every read here is in the config itself.
 */

const harness = doctorHarness();

/** What each environment's composition schedules, and what its stanza fires. */
const CRONS: Record<string, string> = { staging: "0 1 * * *", prod: "0 2 * * *" };

/**
 * Two Workers, so an answer handed to one Worker from the other's config differs too: each answers on
 * `<environment>-<worker>.example.com`, and each stanza serves exactly that host.
 */
async function project(dir: string): Promise<void> {
  await writeFile(
    join(dir, "pithy.config.ts"),
    'export default { name: "acme", environments: ["staging", "prod"] };\n',
  );
  for (const name of ["api", "web"]) await worker(dir, name);
}

async function worker(dir: string, name: string): Promise<void> {
  const workerDir = join(dir, "apps", name);
  await mkdir(workerDir, { recursive: true });
  const stanza = (env: string) => ({
    workers_dev: false,
    routes: [{ pattern: `${env}-${name}.example.com`, custom_domain: true, zone_name: "example.com" }],
    workflows: [{ binding: "DIGEST", name: `acme-${env}-${name}-digest`, class_name: "DigestWorkflow" }],
    triggers: { crons: [CRONS[env]] },
  });
  await writeFile(
    join(workerDir, "wrangler.jsonc"),
    JSON.stringify({ name: `acme-${name}`, env: { staging: stanza("staging"), prod: stanza("prod") } }, null, 2),
  );
  await writeFile(join(workerDir, "pithy.worker.jsonc"), '{ "dev": {} }\n');
  await writeFile(
    join(workerDir, "pithy.config.ts"),
    [
      'const environment = process.env.ENVIRONMENT ?? "none";',
      `const crons = ${JSON.stringify(CRONS)};`,
      `const domain = { pattern: [environment, ${JSON.stringify(`${name}.example.com`)}].join("-"), zone: "example.com" };`,
      "const probe = {",
      '  name: "probe",',
      "  requiredBindings: [],",
      "  settings: {",
      "    local: (context) =>",
      "      context.environments.map((entry) => ({",
      '        setting: "origin",',
      "        environment: entry.name,",
      '        problem: ["answers on", String(entry.origin)].join(" ") + ".",',
      '        action: "Nothing.",',
      "      })),",
      "  },",
      "};",
      "export default {",
      "  domains: { staging: domain, prod: domain },",
      "  app: {",
      `    name: ${JSON.stringify(name)},`,
      "    requiredBindings: [],",
      '    workflows: { digest: { binding: "DIGEST", className: "DigestWorkflow", schedule: crons[environment] ?? "0 9 * * *" } },',
      "  },",
      "  capabilities: [probe],",
      "};",
      "",
    ].join("\n"),
  );
}

/** The report over the fixture: the real resolver, and the real origins, workflows and settings probes. */
function options(): DoctorReportOptions {
  return harness.baseOptions({
    projectDir: harness.dir,
    loadProject: undefined,
    resolveWorkersFor: undefined,
    offline: true,
    readLedger: async () => ({ state: "read", pending: 0, undeclared: [] }),
    checkDevSecrets: async () => null,
    checkSecretBindings: async () => null,
    checkEnvironmentConfigs: async () => ({ unresolved: [] }),
    checkLocalDelivery: async () => null,
    checkDevVars: async () => null,
    checkDevVarsLocal: async () => null,
    checkDevSecretsFile: async () => null,
  });
}

describe("doctor's per-environment sections answer from each environment's composition", () => {
  test("Origins: reports each environment's host from its own composition", async () => {
    await project(harness.dir);
    expect((await buildDoctorReport(options())).origins).toEqual({ state: "ok", drift: [] });
  });

  test("Workflows: compares each environment's stanza with its own composition's declaration", async () => {
    await project(harness.dir);
    expect((await buildDoctorReport(options())).workflows).toEqual({ state: "ok", drift: [] });
  });

  test("the settings check is handed each environment's origin from its own composition", async () => {
    await project(harness.dir);
    const report = await buildDoctorReport(options());
    expect(
      report.settings?.findings.map((finding) => `${finding.worker} ${finding.environment}: ${finding.problem}`).sort(),
    ).toEqual([
      "acme-api prod: answers on https://prod-api.example.com.",
      "acme-api staging: answers on https://staging-api.example.com.",
      "acme-web prod: answers on https://prod-web.example.com.",
      "acme-web staging: answers on https://staging-web.example.com.",
    ]);
  });
});
