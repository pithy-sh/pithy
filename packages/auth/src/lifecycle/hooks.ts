// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { UserLifecycleActorType } from "../data/userLifecycle";
import type { HookRuntime } from "../hooks/runtime";

/**
 * The five seams an adopter's own code follows the account lifecycle through, without polling.
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
 * One hook. Handed the run's D1 binding, for the reason `SessionRevokedListener` is: the listener almost certainly
 * writes to the same database under a different capability's view of it. And handed the Worker it runs in, so it
 * can reach a secret or another binding — start a Workflow, send to a queue, call out. `runtime.waitUntil` is there
 * in a request and absent in the purge Workflow. A hook that takes only `(event, d1)` is still one.
 */
export type UserLifecycleListener<Env = Record<string, unknown>> = (
  event: UserLifecycleHookEvent,
  d1: D1Database,
  runtime: HookRuntime<Env>,
) => void | Promise<void>;

/** The five hooks, each optional. Passed to `auth()` beside the config; `Env` is the adopter's Worker env. */
export interface UserLifecycleHooks<Env = Record<string, unknown>> {
  /** An account was suspended. */
  readonly onUserSuspended?: UserLifecycleListener<Env>;
  /** A suspended account was reinstated. */
  readonly onUserReinstated?: UserLifecycleListener<Env>;
  /** An account was deleted — by an operator or by its owner — and its purge window began. */
  readonly onUserDeleted?: UserLifecycleListener<Env>;
  /**
   * A deleted account was restored inside its purge window. The undo for whatever `onUserDeleted` did: the account
   * is back, and a suspension it was under is still in force.
   */
  readonly onUserRestored?: UserLifecycleListener<Env>;
  /** A deleted account's data was erased. The last thing that happens to it. */
  readonly onUserPurged?: UserLifecycleListener<Env>;
}
