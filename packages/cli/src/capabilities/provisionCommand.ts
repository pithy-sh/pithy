// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import {
  actsOnEveryEnvironment,
  commandFlag,
  commandSequence,
  isCommandPath,
  type Remedy,
  remedy,
  type WorkerDir,
} from "@pithy-sh/core/src/cli/command";
import { LOCAL_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";

/**
 * **`pithy <capability> provision`, as a line names it and an agent runs it (#711).**
 *
 * A capability's provision acts on one Worker — the one whose `wrangler.jsonc` carries the per-environment
 * database and receives the capability's bindings — so it names the Worker, by its `apps/` directory, wherever
 * the command declares `--worker`. Whether it takes `--env`, and whether leaving it off would act on a default,
 * is read from the catalog rather than kept here: `vector provision` defaults to `dev`, so a line about staging
 * names staging; `testers provision` with no `--env` covers every environment; the rest span every environment
 * and take none.
 *
 * `env` is the environment the line is about. A provision against production is a person's decision, said as
 * one, with no `fix` (`@pithy-sh/core/src/cli/command.ts`'s `remedy`). **`productionEnvironments` is required**: it
 * is the project's own `seed.productionEnvironments`, and two sites that left it to a default named the project's
 * `live` as a routine provision (#711). A caller with no project passes `[]`, and says so.
 */
export function capabilityProvisionRemedy(
  capability: string,
  worker: WorkerDir,
  env: string | undefined,
  productionEnvironments: readonly string[],
): Remedy {
  const path = `${capability} provision`;
  // A capability the CLI has no provision for — the adopter's own, or one newer than this CLI — has no command
  // to name, and naming one would be refused as written. The line says what is left to a person.
  if (!isCommandPath(path)) {
    const sentence = `No pithy command provisions ${capability}; bind what it needs by hand in each environment's wrangler.jsonc.`;
    return { fix: undefined, say: () => sentence };
  }
  const flags = {
    ...(commandFlag(path, "--worker") === undefined ? {} : { "--worker": worker }),
    ...(env === undefined || commandFlag(path, "--env") === undefined ? {} : { "--env": env }),
  };
  return remedy(path, { flags }, { productionEnvironments });
}

/**
 * **The provisions a line about every environment of a Worker names** — doctor's, which reads files and is about
 * no single environment. A provision whose `--env` defaults to one environment is named once for each of `envs`,
 * since each must run; one that spans them is named once, without `--env`.
 *
 * One that acts on every environment when `--env` is left off — `testers provision` — is named once for each
 * deployed environment too (#711): bare, it runs against production, a person's decision, and it was offered as the
 * runnable fix for one binding. Named per environment, the ones that are not production stay a fix.
 */
export function capabilityProvisionRemedies(
  capability: string,
  worker: WorkerDir,
  envs: readonly string[],
  productionEnvironments: readonly string[],
): Remedy[] {
  const path = `${capability} provision`;
  const deployed = envs.filter((env) => env !== LOCAL_ENVIRONMENT);
  if (actsOnEveryEnvironment(path) && deployed.length > 0) {
    return deployed.map((env) => capabilityProvisionRemedy(capability, worker, env, productionEnvironments));
  }
  if (commandFlag(path, "--env")?.default === undefined) {
    return [capabilityProvisionRemedy(capability, worker, undefined, productionEnvironments)];
  }
  return envs.map((env) => capabilityProvisionRemedy(capability, worker, env, productionEnvironments));
}

/**
 * **Several remedies as one line**: the commands that run, in code and in order, as `Run a and b.`, then each
 * person's decision in its own sentence. Empty when there is nothing to name.
 */
export function remediesSentence(remedies: readonly Remedy[]): string {
  const commands = remedies.flatMap((one) => (one.fix === undefined ? [] : [one.fix]));
  const people = remedies.filter((one) => one.fix === undefined).map((one) => one.say((command) => command));
  return [commands.length === 0 ? "" : `Run ${commandSequence(commands)}.`, ...people].filter(Boolean).join(" ");
}
