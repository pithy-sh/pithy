// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { SecretRotation } from "./secretRotations";
import { SystemSecret } from "./systemSecrets";

/**
 * The secrets capability's table map: camelCase keys (CamelCasePlugin emits the snake_case
 * `pithy_secrets_` SQL). One source of truth, shared by the capability wiring (`capability.ts`)
 * and the D1 store (`store/systemSecretsStore.ts`) so both type against the same schema.
 */
export const secretsTables = {
  pithySecretsSystemSecrets: SystemSecret,
  pithySecretsRotations: SecretRotation,
};
export type SecretsTables = typeof secretsTables;

/**
 * The vault's tables, which the capability declares **retained** (`DatabaseSpec.retained`): a sealed
 * credential Google or Paddle issued exists here and in their console, nowhere else, and rotation history is
 * the only record of when a key last moved.
 *
 * A constant rather than a literal in `capability.ts`, because two things act on it and neither may hold a
 * second copy: the capability, whose migrations the runner refuses to reverse over rows (#588), and the
 * CLI's teardown, which deletes this database whole and counts these tables first (#591). A copy that
 * drifted would count a table that is not there, find nothing, and delete a vault.
 */
export const secretsRetainedTables = [
  "pithySecretsSystemSecrets",
  "pithySecretsRotations",
] as const satisfies readonly (keyof SecretsTables)[];
