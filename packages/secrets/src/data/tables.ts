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
