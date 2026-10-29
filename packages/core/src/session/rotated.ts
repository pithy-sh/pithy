// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Capability } from "../capability/capability";

/**
 * One session replaced by its successor: a refresh-credential rotation. The capability that owns sessions
 * announces it once the presented session is spent and the successor stands, so a capability that keyed
 * state on the old id can carry it to the new one.
 */
export interface SessionRotation {
  /** The session that was presented and is now gone. */
  readonly previousSessionId: string;
  /** The session that replaces it. */
  readonly sessionId: string;
  /** Whose sessions both are. A listener matches on it as well as the id. */
  readonly userId: string;
  /** The Worker's bindings for this request. */
  readonly env: Record<string, unknown>;
}

/**
 * Hear of a rotation. Called after the successor exists and the presented session is gone; a throw is the
 * listener's own failure, and the rotation it reports has already happened.
 */
export type SessionRotatedListener = (rotation: SessionRotation) => Promise<void>;

/** A listener that threw, named by its capability. */
export interface SessionRotatedFailure {
  readonly capability: string;
  readonly error: unknown;
}

/**
 * Tell every composed capability that declares {@link Capability.sessionRotated}, in composition order. Each
 * listener runs whatever the one before it did; the failures come back for the caller to log.
 */
export async function announceSessionRotated(
  capabilities: readonly Capability[],
  rotation: SessionRotation,
): Promise<SessionRotatedFailure[]> {
  const failures: SessionRotatedFailure[] = [];
  for (const capability of capabilities) {
    const listener = capability.sessionRotated;
    if (!listener) continue;
    try {
      await listener(rotation);
    } catch (error) {
      failures.push({ capability: capability.name, error });
    }
  }
  return failures;
}
