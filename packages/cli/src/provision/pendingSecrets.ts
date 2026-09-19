// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SecretRegistry } from "@pithy-sh/secrets/src/registry";
import { managerMintedSecrets } from "../capabilities/mintSecrets";
import type { ProvisionMode } from "./mode";

/**
 * **What `pithy provision` declares and cannot create, and who — if anyone — can.**
 *
 * A `d1` secret's value is sealed under a master key that lives inside an environment's secrets manager
 * Worker, so only that manager can write one. `pithy provision` runs *before* the managers are
 * necessarily deployed, so it creates none of them. That limit is real and is not a bug to be papered
 * over; finishing quietly was the bug, and #321 closed it by naming the secrets.
 *
 * **What it then named as the fix was true for one mode only (#330).** The line said *run
 * `pithy secrets provision`* whichever mode had been typed. That command iterates the environments the
 * project **declares** and deploys a manager into each, and a branch is not declared.
 *
 * **A branch has a manager of its own since #643.** Every kit Worker a feature composes is provisioned for it,
 * the secrets manager included, and `pithy provision --feature` creates these secrets through it exactly as
 * `pithy secrets provision` does for a declared environment. So a feature run defers one only when it had no
 * Secrets Store to put a manager's key in — no `SECRETS_STORE_ID` on this machine — and the remedy is the
 * same run with one.
 *
 * **It warns; it does not refuse.** `pithy provision --feature` runs per pull request, in CI, and
 * refusing every one of them for a gap the command cannot close would break the pipeline without moving
 * the problem. A feature environment is still the thing it was for every capability that needs no `d1`
 * secret.
 */

/** The `d1` secrets a provisioning run defers, and what creates them — if a command does. */
export interface PendingSecrets {
  /**
   * The secrets, by name, in registry order. **A fact about the registry, not about the mode**: both
   * modes defer the same set, because both run before any manager exists.
   */
  names: string[];
  /**
   * The command that creates them, or `null` when no command does.
   *
   * A string rather than a boolean so the run prints the command it has instead of composing one, and so
   * a pipeline reading `--json` branches on the same value the sentence is built from.
   */
  remedy: string | null;
}

/**
 * What creates a deferred secret, per mode.
 *
 * **A total record over `ProvisionMode["kind"]`, so a third mode fails the build here** rather than
 * inheriting whichever branch happened to come first — which is precisely how `--feature` came to be
 * told `--env`'s answer. `null` is a mode where nothing does, written down rather than left out.
 */
const PENDING_SECRET_REMEDY: Record<ProvisionMode["kind"], string | null> = {
  environment: "pithy secrets provision",
  feature: "pithy provision --feature with SECRETS_STORE_ID set",
};

/**
 * The deferred secrets for one run, from the registry it provisions for and the mode it was asked in.
 *
 * The predicate is {@link managerMintedSecrets} — the same one the creator uses — so a capability that
 * adds an arbitrary `d1` secret tomorrow is named here without a list being maintained.
 */
export function pendingSecrets(registry: SecretRegistry, mode: ProvisionMode): PendingSecrets {
  return { names: managerMintedSecrets(registry), remedy: PENDING_SECRET_REMEDY[mode.kind] };
}

/**
 * The human lines: what was deferred, then what to do about it. Empty when nothing was deferred, so a
 * project declaring no arbitrary `d1` secret reads no paragraph about one.
 *
 * The second line is chosen by `remedy` and by nothing else, so the prose and the `--json` field cannot
 * disagree about whether a command exists. Today the one mode with no remedy is `--feature`, which is
 * what the shortfall sentence describes; the record above is what keeps that true.
 */
export function pendingSecretLines(pending: PendingSecrets): string[] {
  if (pending.names.length === 0) return [];
  return [
    `${pending.names.join(", ")}: not created here — they need a deployed manager.`,
    pending.remedy === null
      ? "A branch gets no manager, and no command creates these for one. This environment comes up without them."
      : `Run ${pending.remedy} to create them.`,
  ];
}
