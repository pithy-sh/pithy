// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { D1Database } from "@cloudflare/workers-types";
import { authDatabase } from "@pithy-sh/auth/src/data/tables";
import { requestRuntime } from "@pithy-sh/auth/src/hooks/runtime";
import type { LifecycleDeps } from "@pithy-sh/auth/src/lifecycle/transitions";
import { AUTH_PURGE_BINDING } from "@pithy-sh/auth/src/purge/specs";
import { startPurgeInstance } from "@pithy-sh/auth/src/purge/start";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { composedCapability } from "@pithy-sh/core/src/capability/composition";
import { fromZodError, InternalError, UnauthorizedError } from "@pithy-sh/core/src/error/pithyError";
import type { Logger } from "@pithy-sh/core/src/logger/logger";
import { workflowBindingFor } from "@pithy-sh/core/src/workflow/dispatch";
import type { ActingMembership } from "../acting/acting";
import { OrganizationAuditActions } from "../audit/actions";
import { correlation, recordOrganizationAction } from "../audit/emit";
import type { OrganizationCapability } from "../capability";
import type { OrganizationConfig } from "../config/config";
import { organizationDatabase } from "../data/tables";
import { OrganizationForbiddenError } from "../error/errors";
import { OperatorReason } from "../http/schemas";
import type { EnqueueInvitation } from "../mail/invitation";
import { ORGANIZATION_PURGE_BINDING } from "../purge/specs";
import { startOrganizationPurgeInstance } from "../purge/start";
import type { RoleCatalog } from "../roles/roles";
import {
  type CascadeDeps,
  type CascadeOutcome,
  deleteSoleMembers,
  NO_CASCADE,
  type UserLifecycleWiring,
} from "./cascade";
import type { OrganizationLifecycleHooks } from "./hooks";
import { type OrganizationLifecycleDeps, removeOrganization } from "./transitions";

/**
 * An owner's deletion of the organization in force — the one code path `DELETE {base}/current` and
 * {@link deleteOrganizationAsOwner} both run.
 *
 * It is the operator's hard deletion with the owner as its actor: `removeOrganization` shuts the organization at once
 * and writes the `deleted` history row, `ownerDelete.members` decides whether the sole-member cascade runs, and the
 * organization purge Workflow is started — every composed `organization` purge contribution as its own step, this
 * capability's last, which runs the adopter's `onDelete` in its batch. Nothing here erases a row itself.
 */

/** The reason recorded when the owner gives none. */
export const OWNER_DELETE_REASON = "Deleted by its owner.";

/** What the owner's deletion is configured with: the same values the routes are handed. */
export interface OwnerDeletionWiring {
  /** The catalog `organization:delete` is asked of. */
  readonly catalog: RoleCatalog<string, string>;
  /** The resolved configuration: `ownerDelete.members`. */
  readonly config: OrganizationConfig;
  /** The D1 binding the tenancy tables live in. */
  readonly databaseBinding: string;
  /** The adopter's organization-lifecycle hooks. */
  readonly lifecycleHooks: OrganizationLifecycleHooks;
  /** The composed auth's lifecycle wiring, which a cascade runs through. */
  readonly userLifecycle: () => UserLifecycleWiring | undefined;
  /** The email enqueue seam, over this request's env, for the cascade's account mail. */
  readonly enqueue?: ((env: Record<string, unknown>) => EnqueueInvitation | undefined) | undefined;
  /** The clock. */
  readonly now?: (() => Date) | undefined;
}

/**
 * What the deletion reads off the request: the Worker, the caller and the membership `requireOrganization()` proved.
 * A Hono context downstream of that gate is one.
 */
export interface OwnerDeletionRequest {
  readonly env: unknown;
  readonly executionCtx?: { waitUntil(promise: Promise<unknown>): void } | undefined;
  readonly var: {
    readonly acting?: ActingMembership | undefined;
    readonly auth: { readonly userId: string; readonly sessionId: string } | null;
    readonly emit: AuditEmit;
    readonly log?: Logger | undefined;
  };
  readonly req: { readonly raw: Request; header(name: string): string | undefined };
}

/** What the owner's deletion did. */
export interface OwnerDeletion {
  /** The organization. */
  readonly organizationId: string;
  /** When it was deleted. */
  readonly deletedAt: Date;
  /** `started` now, or `pending` for the daily pass when no purge Workflow is bound or the start failed. */
  readonly purge: "started" | "pending";
  /** What the member cascade did. `none` with nobody reached unless `ownerDelete.members` is `sole`. */
  readonly members: CascadeOutcome;
}

/**
 * Run an owner's deletion of the organization the request acts in. Refuses, before anything is written, a request
 * with no proved membership, one whose role does not hold `organization:delete`, and a `sole` cascade in a Worker
 * that composes no auth.
 */
export async function runOwnerDeletion(
  wiring: OwnerDeletionWiring,
  c: OwnerDeletionRequest,
  input: { reason?: string | undefined } = {},
): Promise<OwnerDeletion> {
  const acting = c.var.acting;
  if (!acting) {
    throw new OrganizationForbiddenError({
      detail: "an owner's deletion ran with no resolved membership; mount requireOrganization() first",
    });
  }
  if (!wiring.catalog.roleAllows(acting.role, "organization:delete")) {
    throw new OrganizationForbiddenError({
      message: "Your role in this organization does not allow `organization:delete`.",
      detail: `role ${acting.role} does not hold organization:delete in organization ${acting.organizationId}`,
    });
  }
  const session = c.var.auth;
  if (!session) {
    throw new UnauthorizedError({
      message: "Sign in to continue.",
      action: "Retry with a valid session or bearer token.",
      detail: "an owner's deletion ran with no resolved session",
    });
  }
  const env = c.env as Record<string, unknown>;
  const d1 = env[wiring.databaseBinding] as D1Database | undefined;
  if (!d1) {
    throw new InternalError({
      message: "The organization database is not configured.",
      detail: `an owner's deletion found no "${wiring.databaseBinding}" D1 binding on env`,
    });
  }
  // The route validated it already; an app route calling in is held to the same rules here.
  const given = input.reason === undefined ? undefined : OperatorReason.safeParse(input.reason);
  if (given && !given.success) throw fromZodError(given.error);
  const stated = given?.data;
  const organizationId = acting.organizationId;
  const userId = acting.userId;
  const reason = stated ?? OWNER_DELETE_REASON;
  const log = c.var.log?.child("organization");
  const lifecycle: OrganizationLifecycleDeps = {
    db: organizationDatabase(d1),
    d1,
    hooks: wiring.lifecycleHooks,
    runtime: requestRuntime(c),
    log,
    now: wiring.now,
  };
  const mode = wiring.config.ownerDelete.members;
  // Resolved before anything is written, so a Worker that cannot reach accounts refuses rather than half-deleting.
  const cascade = mode === "sole" ? cascadeDeps(wiring, c, d1, organizationId, userId) : undefined;
  const result = await removeOrganization(lifecycle, {
    organizationId,
    actor: { type: "owner", id: userId },
    reason,
    mode: "hard",
    purgeAfterDays: 0,
  });
  // Before the purge is started: the cascade asks who belongs elsewhere, and the purge takes the memberships.
  const members = cascade
    ? await deleteSoleMembers(cascade, {
        organizationId,
        mode: "sole",
        reason,
        deletion: "hard",
        spare: [userId],
        onHard: (memberId, deletedAt) => startMemberPurge(env, log, memberId, deletedAt),
      })
    : NO_CASCADE;
  const purge = await startPurge(env, log, organizationId, result.deletedAt);
  await recordOrganizationAction(c.var.emit, {
    action: OrganizationAuditActions.deleted,
    actor: { organizationId, userId },
    resource: { type: "organization", id: organizationId },
    severity: "warning",
    ...(stated ? { reason: stated } : {}),
    facts: {
      mode: "hard",
      outcome: result.outcome,
      purge,
      members: members.mode,
      reached: members.reached.length,
      skipped: members.skipped.length,
    },
    sessionId: session.sessionId,
    ...correlation(c.req.raw.headers),
  });
  return { organizationId, deletedAt: result.deletedAt, purge, members };
}

/** The cascade's dependencies: auth's own transitions, with the owner as the actor. */
function cascadeDeps(
  wiring: OwnerDeletionWiring,
  c: OwnerDeletionRequest,
  d1: D1Database,
  organizationId: string,
  userId: string,
): CascadeDeps {
  const users = wiring.userLifecycle();
  if (!users) {
    throw new InternalError({
      message: "This Worker cannot reach a member's account, so the cascade could not run.",
      action: "Compose `auth(...)` beside `organization(...)` in this Worker, or set `ownerDelete.members` to `none`.",
      detail: "an owner's deletion with ownerDelete.members sole ran with no user lifecycle wired",
    });
  }
  const enqueue = wiring.enqueue?.(c.env as Record<string, unknown>);
  const deps: LifecycleDeps = {
    db: authDatabase(d1),
    d1,
    emit: c.var.emit,
    config: users.config,
    hooks: users.hooks,
    runtime: requestRuntime(c),
    enqueueEmail: enqueue
      ? (input) =>
          enqueue({
            to: input.to,
            template: input.template,
            payload: input.payload,
            ...(input.locale ? { locale: input.locale } : {}),
          })
      : undefined,
    log: c.var.log?.child("organization"),
    now: wiring.now,
    context: {
      ...correlation(c.req.raw.headers),
      requestId: c.req.header("cf-ray") ?? undefined,
      metadata: { organizationId },
    },
  };
  const now = (wiring.now ?? (() => new Date()))();
  return { db: organizationDatabase(d1), users: deps, actor: { type: "user", id: userId }, now };
}

/**
 * Start the organization's purge now: `pending` when this Worker binds no purge Workflow or the start failed. The
 * deletion is already written either way, and the daily pass starts whatever this could not.
 */
async function startPurge(
  env: Record<string, unknown>,
  log: Logger | undefined,
  organizationId: string,
  deletedAt: Date,
): Promise<"started" | "pending"> {
  const bound = workflowBindingFor(env, ORGANIZATION_PURGE_BINDING);
  if (!bound) {
    log?.warn("a deletion found no organization purge Workflow bound; the purge is pending", { organizationId });
    return "pending";
  }
  try {
    await startOrganizationPurgeInstance(bound, { organizationId, deletedAt: deletedAt.getTime(), at: new Date() });
    return "started";
  } catch (error) {
    log?.warn("the organization purge could not be started; the daily pass will start it", {
      organizationId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return "pending";
  }
}

/** Start one member's account purge after the cascade deleted it, best effort: auth's daily pass starts the rest. */
async function startMemberPurge(
  env: Record<string, unknown>,
  log: Logger | undefined,
  userId: string,
  deletedAt: Date,
): Promise<void> {
  const bound = workflowBindingFor(env, AUTH_PURGE_BINDING);
  if (!bound) return;
  try {
    await startPurgeInstance(bound, { userId, deletedAt: deletedAt.getTime(), at: new Date() });
  } catch (error) {
    log?.warn("a member's purge could not be started; auth's daily pass will start it", {
      userId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Delete the organization the request acts in, as its owner — exactly what `DELETE {base}/current` does, for an app
 * route that adds its own checks first, such as a typed name. Mount `requireSameOrigin()` first, then `requireAuth()`
 * and `requireOrganization()`: it checks no origin itself, and a cookie session is enough to carry the deletion. It
 * refuses a caller whose role does not hold `organization:delete` itself.
 *
 * ```ts
 * import type { D1Database } from "@cloudflare/workers-types";
 * import { requireAuth } from "@pithy-sh/auth/src/http/middleware";
 * import { ValidationError } from "@pithy-sh/core/src/error/pithyError";
 * import { requireSameOrigin } from "@pithy-sh/core/src/http/sameOrigin";
 * import { validate } from "@pithy-sh/core/src/http/validation";
 * import { organizationDatabase } from "@pithy-sh/organization/src/data/tables";
 * import { type OrganizationHonoEnv, requireOrganization } from "@pithy-sh/organization/src/http/guard";
 * import { deleteOrganizationAsOwner } from "@pithy-sh/organization/src/lifecycle/ownerDelete";
 * import { Hono } from "hono";
 * import { z } from "zod";
 * import { roles } from "./organization/roles";
 *
 * const deps = {
 *   catalog: roles,
 *   database: (env: Record<string, unknown>) => organizationDatabase(env.DB as D1Database),
 * };
 *
 * const CloseBody = z
 *   .object({ name: z.string().describe("The organization's name, typed to confirm the deletion.") })
 *   .describe("Close the organization the session acts in.");
 *
 * const app = new Hono<OrganizationHonoEnv>();
 *
 * app.post(
 *   "/settings/close",
 *   requireSameOrigin(),
 *   requireAuth(),
 *   requireOrganization(deps),
 *   validate("json", CloseBody),
 *   async (c) => {
 *     if (c.req.valid("json").name !== c.var.acting.name) throw new ValidationError({ message: "Type the name." });
 *     const deleted = await deleteOrganizationAsOwner(c, { reason: "Closed from settings." });
 *     return c.json({ purge: deleted.purge });
 *   },
 * );
 * ```
 */
export function deleteOrganizationAsOwner(
  c: OwnerDeletionRequest,
  input: { reason?: string | undefined } = {},
): Promise<OwnerDeletion> {
  const organization = composedCapability<OrganizationCapability>(
    "organization",
    (capability) => "organizationOwnerDeletion" in capability,
  );
  return runOwnerDeletion(organization.organizationOwnerDeletion, c, input);
}
