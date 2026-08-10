// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { ValidationError } from "@pithy-sh/core/src/error/pithyError";

/**
 * **Which environment `pithy provision` is provisioning — the flag, and nothing else.**
 *
 * Provisioning is one job with two spellings. A declared environment and a branch's differ only in how
 * the target is *named*: from the root `pithy.config.ts`, or from the checked-out branch. That is a flag,
 * not a different verb, and it was only ever two commands because the naming and the destination stanza
 * used to be independent arguments. `ProvisionScope` fused them, so the safety no longer lives in which
 * command was typed.
 *
 * **`--feature` is declared, never inferred.** Nothing here reads a branch, and nothing may: switching
 * mode because "the branch looks like a feature branch" is how someone on `feature/…` provisions the
 * wrong thing while reading a command line that says nothing about it. The branch is where a feature's
 * *name* comes from, once the operator has said `--feature`.
 *
 * **Refused here, at the flag.** This is a pure function over two booleans' worth of input: no config is
 * loaded, no account is resolved, no Cloudflare client exists yet. `pithy provision --env staging
 * --feature` therefore fails the same way outside a project as inside one, with the sentence about the
 * flags rather than a sentence about whatever the next step happened to need.
 */

/** The target of a provisioning run, as the flags named it. */
export type ProvisionMode =
  | {
      /** A declared environment — `staging`, `prod`, whatever the root config lists. */
      readonly kind: "environment";
      /** The `--env` value, still to be checked against the project's declaration. */
      readonly env: string;
    }
  | {
      /** This branch's own ephemeral environment. */
      readonly kind: "feature";
    };

/** The two flags this reads. Exactly one of them is required, and passing both is a refusal. */
export interface ProvisionModeFlags {
  /** `--env <name>`. Absent as `undefined`, and an empty string counts as absent. */
  env?: string | undefined;
  /** `--feature`. */
  feature: boolean;
}

/** Resolve the mode, or refuse: exactly one of `--env` and `--feature`, always. */
export function requireProvisionMode(flags: ProvisionModeFlags): ProvisionMode {
  const named = flags.env !== undefined && flags.env !== "";
  if (named && flags.feature) {
    throw new ValidationError({
      message: "Pass either --env or --feature, not both.",
      action: "--env <name> provisions an environment the project declares. --feature provisions this branch's.",
    });
  }
  if (named) return { kind: "environment", env: flags.env as string };
  if (flags.feature) return { kind: "feature" };
  throw new ValidationError({
    message: "Provisioning needs an environment to provision.",
    action: "Pass --env <name> for one the project declares, or --feature for this branch's.",
  });
}
