// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SecretRegistryEntry } from "../registry";

/**
 * The value-rotation extension point — **deferred**. Auto-rotating a secret's *value* (re-minting a
 * credential at its source: a fresh API token from the provider, a new signing key) is a future
 * feature. This is the defined-but-unimplemented seam a per-source provider plugin will implement;
 * **no concrete provider ships yet**, and nothing in the package calls it.
 *
 * When it lands, a `rotatable` registry entry will carry a `ValueRotator`; a value-rotation Workflow
 * will call `rotate()` to mint a new value, append it as the next version (`appendVersion`), and —
 * after a grace window — retire the prior version via the planned `retiredAt` TTL on the value
 * envelope (`crypto/versionedValue`). This file exists so that future plugins have a stable contract
 * to build against; it is intentionally inert today.
 */

/** Context handed to a value rotator: the entry being rotated and its current decrypted value. */
export interface ValueRotationContext {
  entry: SecretRegistryEntry;
  currentValue: string;
}

/** The result of minting a new value at the credential's source. */
export interface ValueRotationResult {
  /** The freshly-minted value, to be appended as the next version. */
  newValue: string;
  /** An opaque token a follow-up `cleanup` uses to retire the previous credential after its grace window. */
  cleanupToken?: string;
}

/** A per-source value rotator. No concrete implementation ships yet — value rotation is deferred. */
export interface ValueRotator {
  /** Mint a new value for the secret at its upstream source. */
  rotate(context: ValueRotationContext): Promise<ValueRotationResult>;
  /** Optionally deactivate the previous credential once its overlap window has elapsed. */
  cleanup?(context: ValueRotationContext, cleanupToken: string): Promise<void>;
}
