// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { OrganizationLifecycleActorType } from "../data/organizationLifecycle";

/**
 * The four seams an adopter's own code follows an organization's lifecycle through, without polling (#623).
 *
 * **On the transition, not on a route**, exactly as `@pithy-sh/auth`'s user hooks are: `./transitions.ts` is the
 * only place a transition is written, so it is the only place these fire — once per transition that actually
 * happened, never for a request that found the organization already where it asked to put it.
 *
 * **Non-fatal by contract.** By the time a hook runs the transition is written and recorded. A hook that throws
 * is logged and swallowed, so it can neither undo the transition nor turn it into an error the caller retries.
 */

/** What happened, handed to every hook. */
export interface OrganizationLifecycleHookEvent {
  /** The organization it happened to. */
  readonly organizationId: string;
  /** Who made the transition: the kind, and the principal's id where there is one. */
  readonly actor: { readonly type: OrganizationLifecycleActorType; readonly id: string | null };
  /** The reason given, or null when the transition needed none. */
  readonly reason: string | null;
  /** When the transition was written. */
  readonly at: Date;
  /** For a suspension, when it ends by itself; null for one that lasts until a reinstatement. */
  readonly suspendedUntil?: Date | null;
  /** For a deletion, when the organization's data may be erased. */
  readonly purgeAfter?: Date | null;
}

/** One hook, handed the run's D1 binding for the reason auth's are: it almost certainly writes to that database. */
export type OrganizationLifecycleListener = (
  event: OrganizationLifecycleHookEvent,
  d1: D1Database,
) => void | Promise<void>;

/** The four hooks, each optional. Passed to `organization()` beside the config. */
export interface OrganizationLifecycleHooks {
  /** An organization was suspended. */
  readonly onOrganizationSuspended?: OrganizationLifecycleListener;
  /** A suspended organization was reinstated. */
  readonly onOrganizationReinstated?: OrganizationLifecycleListener;
  /** An organization was deleted, and its purge window began — or, for a hard deletion, closed at once. */
  readonly onOrganizationDeleted?: OrganizationLifecycleListener;
  /** A deleted organization's data was erased. The last thing that happens to it. */
  readonly onOrganizationPurged?: OrganizationLifecycleListener;
}
