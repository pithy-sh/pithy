import { initialVersionedValue } from "../crypto/versionedValue";
import { SecretAlreadyExistsError, SecretNotFoundError } from "../error/errors";
import type { SecretValueType } from "../registry";
import type { RotationTracker } from "../store/rotationTracker";
import type { SystemSecretsStore } from "../store/systemSecretsStore";

/**
 * The management write core — the logic the per-env manager Workflow runs when the CLI dispatches
 * a create/update/remove. Scoped to one environment: the CLI fans a `global` write out to each
 * env's manager, so this core never replicates.
 *
 * **The worker does not validate the value's shape — the CLI does.** A brand-new secret's registry
 * entry (and schema) is not bundled into any *deployed* manager yet, so the worker cannot be the
 * authoritative validator without forcing a deploy before a secret can even be seeded (the
 * chicken-and-egg). The CLI runs from the user's repo with the fresh registry and validates before
 * dispatching. The worker is therefore a secure-but-dumb writer: enforce create/update intent
 * (a store read, atomic with the write, so no TOCTOU), encrypt, store, and seed a rotation baseline.
 *
 * `create` refuses an existing name; `update` refuses a missing one — the guard that keeps a typo
 * from creating a second secret or silently overwriting one. A new value is written as a fresh
 * one-version envelope (`initialVersionedValue`); value rotation (append) is a deferred feature.
 */
export type WriteSecretParams =
  | {
      mode: "create" | "update";
      name: string;
      value: string;
      valueType: SecretValueType;
      /** Whether the secret is rotatable — drives whether a rotation baseline is seeded. */
      rotatable: boolean;
    }
  | { mode: "delete"; name: string };

export interface WriteSecretDeps {
  store: SystemSecretsStore;
  tracker: RotationTracker;
}

export async function runWriteSecret(deps: WriteSecretDeps, params: WriteSecretParams): Promise<void> {
  if (params.mode === "delete") {
    await deps.store.delete(params.name);
    await deps.tracker.purgeHistory(params.name);
    return;
  }

  const exists = await deps.store.has(params.name);
  if (params.mode === "create" && exists) {
    throw new SecretAlreadyExistsError({
      message: `Secret '${params.name}' already exists.`,
      detail: `create '${params.name}': already present in the store`,
    });
  }
  if (params.mode === "update" && !exists) {
    throw new SecretNotFoundError({
      message: `Secret '${params.name}' does not exist.`,
      action: "Use create to add a new secret.",
      detail: `update '${params.name}': not present in the store`,
    });
  }

  await deps.store.put(params.name, initialVersionedValue(params.value), params.valueType);

  // Seed a rotation baseline for a brand-new rotatable secret so the cadence check never reports
  // it immediately overdue purely for lacking history.
  if (params.rotatable && !exists && (await deps.tracker.getLatestSuccess(params.name)) === null) {
    await deps.tracker.recordBaseline(params.name);
  }
}
