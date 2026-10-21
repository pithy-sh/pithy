// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { UserLifecycleActorType } from "../data/userLifecycle";

/**
 * The four seams an adopter's own code follows the account lifecycle through, without polling (#620).
 *
 * **On the transition, not on a route.** An account is suspended from the management surface today and may be
 * from somewhere else tomorrow; a listener hung off one route would miss the others, which is the argument
 * `onSessionRevoked` already makes for the session row. `./transitions.ts` is the only place a transition is
 * written, so it is the only place these fire — once per transition that actually happened, never for a
 * request that found the account already in the state it asked for.
 *
 * **Non-fatal by contract.** By the time a hook runs the transition is written and recorded. A hook that throws
 * is logged and swallowed, so it can neither undo the transition nor turn it into an error the caller retries
 * — a retry would find the account already moved and fire nothing, and the adopter's side effect would be
 * lost either way.
 */

/** What happened, handed to every hook. */
export interface UserLifecycleHookEvent {
  /** The account it happened to. */
  readonly userId: string;
  /** Who made the transition: the kind, and the principal's id where there is one. */
  readonly actor: { readonly type: UserLifecycleActorType; readonly id: string | null };
  /** The reason given, or null when the transition needed none. */
  readonly reason: string | null;
  /** When the transition was written. */
  readonly at: Date;
  /** For a suspension, when it ends by itself; null for one that lasts until a reinstatement. */
  readonly suspendedUntil?: Date | null;
  /** For a deletion, when the account's data may be erased. */
  readonly purgeAfter?: Date | null;
}

/**
 * One hook. Handed the request's D1 binding, for the reason `SessionRevokedListener` is: the listener almost
 * certainly writes to the same database under a different capability's view of it.
 */
export type UserLifecycleListener = (event: UserLifecycleHookEvent, d1: D1Database) => void | Promise<void>;

/** The four hooks, each optional. Passed to `auth()` beside the config. */
export interface UserLifecycleHooks {
  /** An account was suspended. */
  readonly onUserSuspended?: UserLifecycleListener;
  /** A suspended account was reinstated. */
  readonly onUserReinstated?: UserLifecycleListener;
  /** An account was deleted — by an operator or by its owner — and its purge window began. */
  readonly onUserDeleted?: UserLifecycleListener;
  /** A deleted account's data was erased. The last thing that happens to it. */
  readonly onUserPurged?: UserLifecycleListener;
}
