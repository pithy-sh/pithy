// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SecretRegistryEntry } from "../registry";
import type { ManagedEnvironment } from "../scope";

/**
 * **The value-rotation seam, live since #367.** It was declared inert by #322 — "no concrete provider
 * ships yet, and nothing in the package calls it" — because the tag was landing ahead of the act. The tag
 * is `rotation.kind: "provider"`: *replaced by calling the issuer, which returns the new value.* This is
 * the code behind that tag, and `pithy secrets rotate` is what calls it.
 *
 * A function cannot cross into `pithy.manifest.json`, so the declaration and the implementation are two
 * things by construction: the manifest carries `rotation`, which any client branches on, and the registry
 * carries this, which only the process performing a rotation ever holds. `defineSecretRegistry` refuses a
 * pair that disagrees — see `SecretRegistryEntryBase.rotator`.
 *
 * ## The one rule this interface exists to state
 *
 * **`roll` mutates somebody else's system, so it runs exactly once and is never retried.** Everything
 * downstream — storing the value, recording the rotation — retries against what this returned. Rolling
 * again does not repair a failed store; it issues a *third* credential and loses the second, which is the
 * failure the retry was meant to prevent, arriving by way of the retry. `rotateSecretValue` is where that
 * ordering is enforced, and it is enforced there rather than trusted here.
 *
 * ## Retiring the old credential is not here, deliberately
 *
 * #322's first draft hung a `cleanup` off this to deactivate the previous credential once its overlap had
 * elapsed. It is gone: retirement runs on its own clock, long after the rotation, and the overlap window
 * exists precisely so that things issued under the old value keep working. A method called at rotation
 * time that ends the overlap early is data loss wearing a tidy name. `ROTATION_SWEEP` is the kit's existing
 * shape for a scheduled retirement, and that is where it belongs when it lands.
 */

/** What a rotator is told about the secret it is replacing. */
export interface ValueRotationContext {
  /** The registry name of the secret being rotated. */
  name: string;
  /** The environment whose value is being replaced. A rotator holding per-environment credentials needs it. */
  env: ManagedEnvironment;
  /** The registry entry, for a rotator that reads its own declaration rather than restating it. */
  entry: SecretRegistryEntry;
  /**
   * The value being replaced, **when the caller can read it** — and the CLI cannot.
   *
   * Optional, and the optionality is a fact about the architecture rather than a convenience. A `d1`
   * secret is sealed under a master key that never leaves its environment's manager Worker; the CLI's only
   * read seam (`SecretProbe`) resolves to a bit, and "there is no shape of request that would make it"
   * return a value. So `pithy secrets rotate` calls a rotator with this absent, always.
   *
   * A rotator whose provider authenticates with the credential being replaced — GitLab's token rotation is
   * the case — therefore cannot be driven from the CLI, and must say so plainly rather than fail obscurely.
   * It has its own credentials, or it refuses.
   */
  currentValue?: string;
}

/** What a rotator gives back. The successor value, and nothing else — there is nothing else to carry. */
export interface ValueRotationResult {
  /** The freshly-issued value. Stored, never returned to a caller, never printed, never logged. */
  newValue: string;
}

/**
 * A per-secret value rotator. Supplied on the registry entry by whoever owns the secret — the capability
 * that declares it, or the adopter who declared their own.
 */
export interface ValueRotator {
  /**
   * Roll the credential at its issuer and return the successor.
   *
   * **Called at most once per rotation, and never speculatively.** By the time this returns, the previous
   * value may already be dead at the provider and this value may be the only copy in existence.
   */
  roll(context: ValueRotationContext): Promise<ValueRotationResult>;
}
