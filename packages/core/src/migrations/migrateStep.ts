// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { commandName, pithyCommand } from "../cli/command";
import { type AmbientEnv, compositionEnvironment } from "../env/ambient";

/**
 * **The step that migrates the environment a Worker runs in**, as a sentence ends with it: `then ${step}.`
 *
 * `pithy migrate` defaults to `dev`, so a line that names it bare sends a staging Worker's operator to migrate
 * their laptop (#711). A Worker knows its environment when the composition stamped one (`ENVIRONMENT`), and then
 * the command names it; when it does not, the line says which flag to name rather than naming a command that
 * would act on the wrong database.
 */
export function migrateStep(env: AmbientEnv): string {
  const environment = compositionEnvironment(env);
  if (environment === undefined) return `migrate this environment with ${commandName("migrate")}, naming it with --env`;
  return `run ${pithyCommand("migrate", { flags: { "--env": environment } })}`;
}
