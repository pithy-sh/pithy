// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { type Command, type Remedy, remedy } from "@pithy-sh/core/src/cli/command";
import type { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { FEATURE_ENVIRONMENT } from "@pithy-sh/core/src/naming/environment";
import { withFix } from "../terminal/exitClass";

/**
 * **The remedy for an unprovisioned environment (#697, #711)**, decided by the builder rather than by each site.
 *
 * - **A feature** is brought up by `pithy provision --feature`; `pithy provision` refuses `--env feature`.
 * - **A production environment is a person's decision.** Provisioning one needs the `--confirm` phrase on top of
 *   `--yes`, and the phrase is a person's to give: `pithy provision --env prod --yes` ends
 *   `core/person_required`, exit 5. So it carries no `fix`, and the line names the command as a person's
 *   decision, never spelling the phrase — written into a line an agent reads, it would be a confirmation nobody
 *   gave.
 * - **Anything else** is `pithy provision --env <env> --yes`.
 *
 * `productionEnvironments` is the project's `seed.productionEnvironments`, where the caller has it; `prod` and
 * `production` are production without it.
 */
export function provisionRemedy(env: string, productionEnvironments: readonly string[] = []): Remedy {
  if (env === FEATURE_ENVIRONMENT) return remedy("provision", { flags: { "--feature": true } });
  return remedy("provision", { flags: { "--env": env, "--yes": true } }, { productionEnvironments });
}

/** Attach {@link provisionRemedy}'s `fix` to `error`, when it has one, and hand the same error back. */
export function withProvisionFix<E extends PithyError>(
  error: E,
  env: string,
  productionEnvironments: readonly string[] = [],
): E {
  const { fix } = provisionRemedy(env, productionEnvironments);
  return fix === undefined ? error : withFix(error, fix);
}

/** {@link provisionRemedy}'s `fix`, or `null` — for a report that names a remedy without throwing one. */
export function provisionFixCommand(env: string, productionEnvironments: readonly string[] = []): Command | null {
  return provisionRemedy(env, productionEnvironments).fix ?? null;
}
