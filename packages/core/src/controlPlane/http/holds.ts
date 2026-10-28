// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import type { PithyHonoEnv } from "../../capability/capability";
import { countActiveHolds, listHolds, placeHold, releaseHold } from "../../retention/holds";
import { ControlPlaneAuditActions, safeEmit } from "../audit/actions";
import type { LegalHold } from "../data/hold";
import { type ControlPlaneHandlerDeps, caller } from "./handlers";
import type { ControlPlaneHoldResponse, ControlPlaneHoldsResponse, LegalHoldView } from "./responses";
import type { HoldListQuery, HoldParams, PlaceHoldRequest, ReleaseHoldRequest } from "./schemas";

/**
 * The legal-hold routes: place, release, list.
 *
 * Placing and releasing are each audited under `controlplane/*`, which the retention floor keeps at least a year,
 * with the subject, the hold and the reason. A hold suspends every purge, prune and inactivity deletion touching its
 * subject; the capabilities that erase read it through `retention/holds.ts`. **Nothing here shortens a retention**:
 * a hold can only preserve, and its release returns the subject to the policy the Worker was deployed with.
 */

/** The default page of `GET /control-plane/holds`. */
const DEFAULT_HOLD_LIMIT = 100;

/** A hold, as the routes answer it. */
export function holdView(hold: LegalHold): LegalHoldView {
  return {
    id: hold.id,
    subjectType: hold.subjectType,
    subjectId: hold.subjectId,
    reason: hold.reason,
    placedBy: hold.placedBy,
    placedAt: hold.placedAt.toISOString(),
    state: hold.state,
    releasedAt: hold.releasedAt?.toISOString() ?? null,
    releasedBy: hold.releasedBy,
    releaseReason: hold.releaseReason,
  };
}

/** The audit event for a placement or a release: the subject as the resource, the hold and the reason beside it. */
async function auditHold(c: Context<PithyHonoEnv>, action: string, hold: LegalHold, reason: string): Promise<void> {
  const context = caller(c);
  await safeEmit(
    c.var.emit,
    {
      action,
      outcome: "success",
      severity: "warning",
      actorType: "control-plane",
      actorId: context.subject,
      resourceType: hold.subjectType === "audit" ? "audit_trail" : hold.subjectType,
      resourceId: hold.subjectId,
      requestId: c.req.header("cf-ray"),
      ip: c.req.header("cf-connecting-ip"),
      userAgent: c.req.header("user-agent"),
      metadata: { holdId: hold.id, subjectType: hold.subjectType, reason },
    },
    c.var.log,
  );
}

/** `POST /control-plane/holds` — place a hold. */
export function placeHoldHandler(deps: ControlPlaneHandlerDeps) {
  return async (c: Context<PithyHonoEnv>, body: PlaceHoldRequest) => {
    const context = caller(c);
    const hold = await placeHold(deps.database(c), {
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      reason: body.reason,
      actor: { subject: context.subject },
      at: deps.now(),
    });
    await auditHold(c, ControlPlaneAuditActions.holdPlaced, hold, body.reason);
    return c.json({ hold: holdView(hold) } satisfies ControlPlaneHoldResponse, 201);
  };
}

/** `POST /control-plane/holds/:holdId/release` — release a hold, with a reason. */
export function releaseHoldHandler(deps: ControlPlaneHandlerDeps) {
  return async (c: Context<PithyHonoEnv>, params: HoldParams, body: ReleaseHoldRequest) => {
    const context = caller(c);
    const hold = await releaseHold(deps.database(c), {
      id: params.holdId,
      reason: body.reason,
      actor: { subject: context.subject },
      at: deps.now(),
    });
    await auditHold(c, ControlPlaneAuditActions.holdReleased, hold, body.reason);
    return c.json({ hold: holdView(hold) } satisfies ControlPlaneHoldResponse);
  };
}

/** `GET /control-plane/holds` — every hold, standing first. Read-only. */
export function listHoldsHandler(deps: ControlPlaneHandlerDeps) {
  return async (c: Context<PithyHonoEnv>, query: HoldListQuery) => {
    caller(c);
    const db = deps.database(c);
    const holds = await listHolds(db, {
      ...(query.state ? { state: query.state } : {}),
      limit: query.limit ?? DEFAULT_HOLD_LIMIT,
    });
    return c.json({
      active: await countActiveHolds(db),
      holds: holds.map(holdView),
    } satisfies ControlPlaneHoldsResponse);
  };
}
