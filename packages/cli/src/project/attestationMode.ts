// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "@pithy-sh/core/src/capability/capability";
import { commandName, type WorkerDir } from "@pithy-sh/core/src/cli/command";
import { PreconditionFailedError, ValidationError } from "@pithy-sh/core/src/error/pithyError";
import { isProductionEnv } from "../seed/safety";
import { resolveWorkersFor } from "./composeFor";
import { loadProject } from "./config";
import { workerDirName } from "./workerIdentity";

/**
 * **A production environment whose auth accepts the test assertion.**
 *
 * `@pithy-sh/auth`'s attestation block is per environment, and `test` mode accepts a fixed, documented
 * assertion in place of a real app's. The Worker itself accepts that assertion only where `ENVIRONMENT` is `dev`,
 * `staging` or `feature`, so this is the second line: `pithy doctor` reports the configuration and `pithy deploy`
 * refuses it, for `prod` and for every name the project lists in `seed.productionEnvironments`.
 *
 * The CLI does not depend on `@pithy-sh/auth` at runtime, so auth is found by its name and its `authConfig`.
 */

/** One Worker whose auth sets a production environment to `test`. */
export interface TestAttestationFinding {
  /** The Worker's `apps/<name>` directory name. */
  worker: WorkerDir;
  /** The production environment its block sets to `test`. */
  environment: string;
}

/** What `doctor` learned. `could-not-check` when a composition threw and nothing was found anyway. */
export interface AttestationCheck {
  state: "ok" | "could-not-check" | "findings";
  findings: TestAttestationFinding[];
}

/** One Worker composed for one environment. */
export type ComposeCapabilitiesFor = (
  worker: { name: string; dir: string },
  environment: string,
) => Promise<{ capabilities: readonly Capability[] }>;

/** What both readers walk. */
export interface AttestationModeOptions {
  /** The project's Workers. */
  workers: readonly { name: string; dir: string }[];
  /** The environments to ask about. Only the production ones among them are read. */
  environments: readonly string[];
  /** The project's `seed.productionEnvironments`, beyond `prod`. */
  productionEnvironments: readonly string[];
  /** The composition for one Worker in one environment. */
  composeWorker: ComposeCapabilitiesFor;
}

/** The mode auth's attestation block sets for `environment`, or `null` when there is no auth or no block. */
export function attestationModeOf(capabilities: readonly Capability[], environment: string): string | null {
  const found = capabilities.find((capability) => capability.name === "auth" && "authConfig" in capability);
  const config = (found as { authConfig?: { attestation?: { environments?: Record<string, unknown> } } } | undefined)
    ?.authConfig;
  const environments = config?.attestation?.environments;
  if (environments === undefined || !Object.hasOwn(environments, environment)) return null;
  const mode = (environments[environment] as { mode?: unknown } | undefined)?.mode;
  return typeof mode === "string" ? mode : null;
}

/** Every Worker and production environment set to `test`, and whether a composition could not be read. */
async function walk(
  options: AttestationModeOptions,
): Promise<{ findings: TestAttestationFinding[]; unreadable: boolean }> {
  const findings: TestAttestationFinding[] = [];
  let unreadable = false;
  const production = options.environments.filter((env) => isProductionEnv(env, options.productionEnvironments));
  for (const environment of production) {
    for (const worker of options.workers) {
      let capabilities: readonly Capability[];
      try {
        capabilities = (await options.composeWorker(worker, environment)).capabilities;
      } catch {
        unreadable = true;
        continue;
      }
      if (attestationModeOf(capabilities, environment) === "test") {
        findings.push({ worker: workerDirName(worker), environment });
      }
    }
  }
  return { findings, unreadable };
}

/** The `Attestation:` block's answer for `pithy doctor`. Never throws. */
export async function checkAttestation(options: AttestationModeOptions): Promise<AttestationCheck> {
  const { findings, unreadable } = await walk(options);
  if (findings.length > 0) return { state: "findings", findings };
  return { state: unreadable ? "could-not-check" : "ok", findings: [] };
}

/** One finding as a line. */
export function describeTestAttestation(finding: TestAttestationFinding): string {
  const config = `apps/${finding.worker}/pithy.config.ts`;
  return `${finding.worker}: ${finding.environment} sets auth's attestation to test, which accepts a test assertion in place of a real app. Set attestation.environments.${finding.environment}.mode to enforce in ${config}. A production Worker refuses the test assertion anyway, and ${commandName("deploy")} refuses the environment.`;
}

/**
 * Refuse to deploy a production environment whose auth is set to `test`. Exit 3, a precondition: the remedy is
 * an edit to config, so no command is named as its fix. A Worker that will not compose is not refused here; the
 * deploy's own composition reports it.
 */
export async function assertNoTestAttestation(
  options: AttestationModeOptions & { environment: string },
): Promise<void> {
  const { findings } = await walk({ ...options, environments: [options.environment] });
  if (findings.length === 0) return;
  throw new PreconditionFailedError({
    message: `${options.environment} sets attestation to test: ${findings.map((found) => found.worker).join(", ")}.`,
    action: findings.map(describeTestAttestation).join(" "),
    detail:
      "A production environment in test mode would accept the documented test assertion from any caller. The Worker accepts it only where ENVIRONMENT is dev, staging or feature; this refuses the configuration before it ships.",
  });
}

/**
 * {@link assertNoTestAttestation} for `pithy deploy --env <env>`: every Worker under `apps/`, composed for `env`
 * once. Asks nothing of an environment that is not production, and refuses nothing when the project will not load.
 */
export async function assertAttestationDeployable(projectDir: string, environment: string): Promise<void> {
  const config = await loadProject(projectDir).catch(() => null);
  if (config === null) return;
  const productionEnvironments = config.seed?.productionEnvironments ?? [];
  if (!isProductionEnv(environment, productionEnvironments)) return;
  const resolved = await resolveWorkersFor(environment, { projectDir }).catch(() => null);
  if (resolved === null) return;
  await assertNoTestAttestation({
    workers: resolved,
    environments: [environment],
    productionEnvironments,
    environment,
    composeWorker: async (worker) => {
      const match = resolved.find((candidate) => candidate.dir === worker.dir);
      if (match === undefined) throw new ValidationError({ message: `${worker.name} did not resolve.` });
      return match;
    },
  });
}
