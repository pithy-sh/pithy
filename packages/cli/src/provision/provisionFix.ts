// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { isProductionEnv } from "../seed/safety";
import { withFix } from "../terminal/exitClass";

/**
 * Attach the provisioning command that rights an unprovisioned `env` as the refusal's `fix` (#697), or
 * none when no command can.
 *
 * - **A feature** is brought up by `pithy provision --feature`; `pithy provision` refuses `--env feature`.
 * - **A production environment gets no `fix`.** Provisioning one needs the `--confirm` phrase on top of
 *   `--yes`, and the phrase is a person's to give: `pithy provision --env prod --yes` ends
 *   `core/person_required`, exit 5. A `fix` is runnable as written (`docs/CLI.md` §3.3), so the refusal
 *   keeps its action line, for the person, and names no command for an agent to run.
 * - **Anything else** is `pithy provision --env <env> --yes`.
 *
 * `productionEnvironments` is the project's `seed.productionEnvironments`, where the caller has it;
 * `prod` and `production` are production without it.
 */
export function withProvisionFix<E extends PithyError>(
  error: E,
  env: string,
  productionEnvironments: readonly string[] = [],
): E {
  if (env === FEATURE_ENVIRONMENT) return withFix(error, { fix: "pithy provision --feature" });
  if (isProductionEnv(env, productionEnvironments)) return error;
  return withFix(error, { fix: `pithy provision --env ${env} --yes` });
}
