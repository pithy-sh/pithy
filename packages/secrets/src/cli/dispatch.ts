import type { SecretBackend, SecretScope, SecretValueType } from "../registry";
import { type ManagedEnvironment, resolveWriteTargets } from "../scope";

/**
 * One write/delete dispatched to a single environment's manager Workflow. The CLI never encrypts or
 * writes locally — the master key is worker-only — so every value-touching command becomes one of
 * these per target environment.
 */
export interface SecretWriteRequest {
  env: ManagedEnvironment;
  mode: "create" | "update" | "delete";
  name: string;
  /** Present for create/update; omitted for delete. Already validated + canonicalized by the CLI. */
  value?: string;
  valueType?: SecretValueType;
  rotatable?: boolean;
}

/**
 * The dispatch seam: send one request to an environment's manager Workflow and resolve once it
 * reaches a terminal state. Stubbed in tests; backed by the CF Workflows REST client (dispatch +
 * poll) in the manager-worker/provisioning slice.
 */
export interface SecretDispatcher {
  dispatch(request: SecretWriteRequest): Promise<void>;
}

/** A value-touching command before routing — the CLI resolves backend/scope from the registry. */
export interface SecretWrite {
  mode: "create" | "update" | "delete";
  name: string;
  backend: SecretBackend;
  scope: SecretScope;
  rotatable: boolean;
  valueType: SecretValueType;
  /** The validated value for create/update; omitted for delete. */
  value?: string;
  /** The operator-requested env, used for an `environment`-scoped write. */
  requested: ManagedEnvironment;
}

/**
 * Route a write by backend × scope (`resolveWriteTargets`) and dispatch it to each target
 * environment's manager, in order. A `global` write reaches both environments; an
 * `environment` write reaches exactly one. Returns the environments written, for the CLI to report.
 */
export async function dispatchSecretWrite(
  dispatcher: SecretDispatcher,
  write: SecretWrite,
): Promise<ManagedEnvironment[]> {
  const targets = resolveWriteTargets(write.backend, write.scope, write.requested);
  for (const env of targets) {
    await dispatcher.dispatch({
      env,
      mode: write.mode,
      name: write.name,
      value: write.value,
      valueType: write.valueType,
      rotatable: write.rotatable,
    });
  }
  return targets;
}
