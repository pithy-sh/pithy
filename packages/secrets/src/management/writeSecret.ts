// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
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
 * from creating a second secret or silently overwriting one. `probe` writes nothing and answers
 * whether a name is there. A new value is written as a fresh one-version envelope
 * (`initialVersionedValue`); value rotation (append) is a deferred feature.
 */
export type WriteSecretParams =
  | {
      /** `create` refuses an existing name; `update` refuses a missing one. */
      mode: "create" | "update";
      name: string;
      value: string;
      valueType: SecretValueType;
      /** Whether the secret is rotatable — drives whether a rotation baseline is seeded. */
      rotatable: boolean;
    }
  | {
      /**
       * **Is this name in the store?** The one read the CLI cannot do for itself: a `d1` value is
       * sealed under a master key that never leaves this worker, so only the manager can answer.
       *
       * It writes nothing, decrypts nothing, and returns nothing but `present` or `absent` — a
       * presence bit is not a secret, and no path here can be coaxed into returning a value.
       *
       * **It replaced `ensure`, and the replacement is the fix.** `ensure` wrote only when the name
       * was absent and was otherwise a silent no-op, which is a *per-environment* answer to a
       * *cross-environment* question. A `global` secret is defined by being identical everywhere, and
       * a run that wrote staging, lost prod, and was re-run minted a second value, found staging
       * present, skipped it, and wrote the second value to prod — two environments, two values, no
       * error. Silence is what made that unnoticeable, so the mode that could be silent is gone. The
       * caller asks first, decides across every environment at once, and writes with `create`, which
       * cannot skip: it raises. See `cli/mintSecrets.ts` in the CLI.
       */
      mode: "probe";
      name: string;
    }
  | { mode: "delete"; name: string };

/**
 * What one write actually did — the manager's answer, and the thing the caller could not otherwise
 * know. A `d1` secret is sealed under a master key that never leaves this worker, so "was it already
 * there" is a question only the store holder can be asked, and dropping the answer on the floor is how
 * a partial fan-out completes silently.
 *
 * A Zod enum rather than a bare union because it crosses back out of the Worker as a Workflow
 * instance's `output` and is decoded on the far side like every other external input.
 */
export const WriteSecretOutcome = z
  .enum(["written", "present", "absent", "deleted"])
  .describe(
    "What a management write did: wrote a new value, found the name already present, found it absent, or removed it.",
  );
export type WriteSecretOutcome = z.output<typeof WriteSecretOutcome>;

export interface WriteSecretDeps {
  store: SystemSecretsStore;
  tracker: RotationTracker;
}

export async function runWriteSecret(deps: WriteSecretDeps, params: WriteSecretParams): Promise<WriteSecretOutcome> {
  if (params.mode === "delete") {
    await deps.store.delete(params.name);
    await deps.tracker.purgeHistory(params.name);
    return "deleted";
  }

  const exists = await deps.store.has(params.name);
  // The read, and only the read. Nothing is written, nothing is decrypted, and the answer is one bit.
  if (params.mode === "probe") return exists ? "present" : "absent";
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
  //
  // **And nothing else here records anything, which is the point rather than the omission (`#379`).** A
  // first write establishes a value; a rotation replaces one; they are different events and the ledger
  // keeps them apart by `trigger`. This is a writer, and a writer cannot tell which it is being used for:
  // an `update` is a rotation, a value pasted from a console, or a typo fix, and inferring a rotation from
  // it would advance a freshness clock nobody rotated. The act declares itself — `rotateSecretValue` opens
  // and closes the row around the roll, for every caller. See `../rotation/rotationLedger.ts`.
  if (params.rotatable && !exists && (await deps.tracker.getLatestSuccess(params.name)) === null) {
    await deps.tracker.recordBaseline(params.name);
  }
  return "written";
}
