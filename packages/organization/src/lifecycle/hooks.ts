// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import type { OrganizationLifecycleActorType } from "../data/organizationLifecycle";

/**
 * The seams an adopter's own code follows an organization's lifecycle and its memberships through, without polling.
 *
 * **The organization hooks fire on the transition, not on a route**, exactly as `@pithy-sh/auth`'s user hooks do:
 * `./transitions.ts` is the only place a transition is written, so it is the only place they fire — once per
 * transition that actually happened. The membership hooks fire after every route that changes a role or ends a
 * membership has written it and recorded it, once per member it changed.
 *
 * **Non-fatal by contract.** By the time a hook runs the change is written and recorded. A hook that throws
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

/** Who changed a membership: a member through the app's own routes, or a management client over the control plane. */
export type MembershipActor =
  | { readonly type: "member"; readonly userId: string }
  | { readonly type: "control-plane"; readonly connectionId: string | null };

/** A member's role changed, handed to {@link OrganizationLifecycleHooks.onMemberRoleChanged}. */
export interface MemberRoleChangedEvent {
  readonly organizationId: string;
  readonly membershipId: string;
  /** The member whose role changed. */
  readonly userId: string;
  readonly previousRole: string;
  readonly role: string;
  /**
   * The powers the previous role held and the new one does not, in the catalog's order. Empty for a promotion. A
   * management client re-checks what this member's agents were granted when it is not.
   */
  readonly powersLost: readonly string[];
  readonly actor: MembershipActor;
  readonly at: Date;
}

/** A membership ended, handed to {@link OrganizationLifecycleHooks.onMemberRemoved}. */
export interface MemberRemovedEvent {
  readonly organizationId: string;
  readonly membershipId: string;
  /** The member who is no longer one. */
  readonly userId: string;
  /** The role they held when it ended. */
  readonly role: string;
  /** True when they left of their own accord. */
  readonly left: boolean;
  readonly actor: MembershipActor;
  readonly at: Date;
}

/** The organization lifecycle hooks, each optional. Passed to `organization()` beside the config. */
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

/** The membership hooks, each optional. Passed to `organization()` beside the lifecycle hooks. */
export interface OrganizationMembershipHooks {
  /** A member's role changed, through any route: a member's, an ownership transfer, or an operator's. */
  readonly onMemberRoleChanged?: (event: MemberRoleChangedEvent, d1: D1Database) => void | Promise<void>;
  /** A membership ended, through any route: removed, left, or removed by an operator. */
  readonly onMemberRemoved?: (event: MemberRemovedEvent, d1: D1Database) => void | Promise<void>;
}
