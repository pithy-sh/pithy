// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { join } from "node:path";
import { resolveClientProjection } from "@pithy-sh/core/src/capability/client";
import { fromZodError } from "@pithy-sh/core/src/error/pithyError";
import { baseUrlFor, domainFor } from "@pithy-sh/core/src/naming/domains";
import { DEFAULT_ENVIRONMENTS, LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import {
  GENERATED_CONFIG_PATH,
  GeneratedConfig,
  type Origins,
  type PlatformRails,
} from "@pithy-sh/ui-react-native/src/generatedConfig";
import { devConfigPath, readDevConfig } from "../feature/devConfig";
import { BASE_PORT } from "../feature/ports";
import { allCapabilities, loadWorkerDomains, projectEnvironments, type WorkerConfig } from "../project/config";
import { readAddressStanza, resolveWorkerAddress } from "../project/workerAddress";
import { deriveWorkerFirst } from "./routeAllowlist";

/**
 * The values `pithy-config.generated.ts` holds, worked out from the backend Worker's composed config.
 *
 * The file's format belongs to `@pithy-sh/ui-react-native`; this module decides what goes in it. The
 * projections are each capability's client projection for each environment the origins name, the same values
 * `virtual:pithy/*` serves a Vite app built for that environment. The Worker paths are the base paths its composed
 * route table answers under, which the web build's dev proxy forwards. The origins are the backend's address in
 * each environment. The scheme and the universal-link origin are first guesses the adopter keeps editing, and a
 * sync keeps their edits.
 */

/** The capabilities whose projections the file carries. */
const PROJECTED = ["auth", "i18n", "payments", "turnstile", "consent"] as const;

/**
 * Where the backend answers under `pithy dev`: the origin `.dev.config.json` pins for it, or the first port of
 * the dev block when no dev session has pinned one yet. A sync rewrites it from the pinned one.
 */
export async function devOrigin(projectDir: string, deployedName: string | undefined): Promise<string> {
  const pinned = await readDevConfig(devConfigPath(projectDir)).catch(() => null);
  const origin = deployedName === undefined ? undefined : pinned?.workers[deployedName]?.origin;
  return origin ?? `http://localhost:${BASE_PORT}`;
}

/** The app's URL scheme: its directory name, prefixed when that does not start with a letter. */
export function appSchemeFor(app: string): string {
  return /^[a-z]/.test(app) ? app : `app${app}`;
}

/**
 * The https origin whose links open the app: the backend's production domain, then its staging one, and none
 * when it declares neither. The adopter sets the real one before a store build.
 */
export function universalLinkOriginFor(config: WorkerConfig): string | null {
  const domains = loadWorkerDomains(config);
  const domain = domainFor(domains, "prod") ?? domainFor(domains, "staging");
  return domain === null ? null : baseUrlFor(domain);
}

/** The environments whose origin the file carries. */
const DEPLOYED = ["staging", "prod"] as const;

/**
 * Where the backend answers in each environment: its local origin, and for each environment the project deploys
 * to, its declared domain, else its route, else its `BASE_URL`, read offline. `null` when none of those names one —
 * a Worker that answers only on workers.dev among them, since that address needs the account to resolve. An
 * environment the project does not deploy to is left out.
 */
export async function originsFor(input: {
  projectDir: string;
  workerDir: string;
  config: WorkerConfig;
  deployedName?: string | undefined;
  /** The project's environments. Read from the root `pithy.config.ts` when absent. */
  environments?: readonly string[] | undefined;
}): Promise<Origins> {
  const environments =
    input.environments ?? (await projectEnvironments(input.projectDir).catch(() => [...DEFAULT_ENVIRONMENTS]));
  const domains = loadWorkerDomains(input.config);
  const origins: Origins = { dev: await devOrigin(input.projectDir, input.deployedName) };
  for (const environment of DEPLOYED) {
    if (!environments.includes(environment)) continue;
    const stanza = await readAddressStanza(input.workerDir, environment);
    origins[environment] = resolveWorkerAddress({ environment, domains, stanza })?.url ?? null;
  }
  return origins;
}

/** The whole config for an app scaffolded against `config`, before any adopter edit. */
export function buildGeneratedConfig(input: {
  config: WorkerConfig;
  app: string;
  origins: Origins;
  rails: PlatformRails;
}): GeneratedConfig {
  const capabilities = allCapabilities(input.config);
  // Every environment the file carries an origin for, `null` included: a build for it still needs its projection.
  const environments = [LOCAL_ENVIRONMENT, ...DEPLOYED.filter((environment) => environment in input.origins)];
  const projections = (name: (typeof PROJECTED)[number]) => {
    const capability = capabilities.find((composed) => composed.name === name);
    return Object.fromEntries(
      environments.map((environment) => [environment, resolveClientProjection(capability, { environment })]),
    );
  };
  const parsed = GeneratedConfig.safeParse({
    origins: input.origins,
    appScheme: appSchemeFor(input.app),
    universalLinkOrigin: universalLinkOriginFor(input.config),
    rails: input.rails,
    google: { webClientId: null, iosClientId: null },
    // The dev proxy forwards these under `pithy dev`, so the local route table is the one that counts.
    workerPaths: deriveWorkerFirst(input.config, []).filter((pattern) => !pattern.endsWith("/*")),
    ...Object.fromEntries(PROJECTED.map((name) => [name, projections(name)])),
  });
  if (parsed.success) return parsed.data;
  throw fromZodError(parsed.error, {
    message: `The config for apps/${input.app} is not one an Expo app can read.`,
    action:
      "Check the worker's pinned origin in .dev.config.json and its domains in pithy.config.ts, then run the command again.",
  });
}

/** Where the file sits for an app directory. */
export function generatedConfigFile(appDir: string): string {
  return join(appDir, GENERATED_CONFIG_PATH);
}
