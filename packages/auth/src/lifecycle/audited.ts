// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { emitControlPlaneAction } from "../audit/emit";

/**
 * Every control-plane lifecycle call is audited, including the ones that changed nothing (#621).
 *
 * A transition that moves the account writes its own audit event, beside the history row, in
 * `./transitions.ts`. That leaves two kinds of call with no event, and both matter to somebody reading the
 * trail after an incident: **a refusal** — an unknown account, a deleted one, an end in the past — which says
 * a credential was trying, and **a call that found the account already where it asked to put it**, which
 * says somebody pressed the button. This records both, under the same action as the transition, so one
 * filter finds every attempt: a refusal is `denied` (or `failure` for a fault) with the code, and a no-op is
 * a `success` with `changed: false`. A refusal is still thrown, unchanged.
 *
 * A body the route's validator refuses never reaches the call, so the route records it with
 * {@link recordLifecycleRefusal}, on the same event, before the 400 is thrown.
 */

/** Who called, about whom, and why — what every lifecycle audit event carries. */
export interface LifecycleCall {
  /** The audit action the transition writes when it moves the account. */
  readonly action: string;
  /** The management client's verified `sub`: which person acted. */
  readonly subject: string;
  /** The connection the call came through. */
  readonly connectionId: string;
  /** The account acted on. */
  readonly userId: string;
  /** The reason the caller gave — `null` for a refused body that carried none. */
  readonly reason: string | null;
  /** The request's correlation. */
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly requestId?: string | undefined;
}

/** The public code of a thrown error, or `core/internal` for anything that is not a `PithyError`. */
function codeOf(error: unknown): string {
  return error instanceof PithyError ? error.payload.code : "core/internal";
}

/** A refusal this Worker made on purpose is `denied`; a fault, a 5xx or a throw that is not ours, `failure`. */
function outcomeOf(error: unknown): "denied" | "failure" {
  return error instanceof PithyError && error.payload.status < 500 ? "denied" : "failure";
}

/** The event every lifecycle audit record shares, before its outcome and metadata. */
function eventOf(call: LifecycleCall) {
  return {
    action: call.action,
    subject: call.subject,
    connectionId: call.connectionId,
    resourceType: "user",
    resourceId: call.userId,
    ip: call.ip,
    userAgent: call.userAgent,
    requestId: call.requestId,
  };
}

/**
 * Record one refused lifecycle call — `denied` with its code, or `failure` for a fault. `code` names the
 * refusal when the thrown error carries none of its own, as a body Hono could not parse does not.
 */
export async function recordLifecycleRefusal(
  emit: AuditEmit,
  call: LifecycleCall,
  error: unknown,
  fallback?: { code: string; outcome: "denied" | "failure" },
): Promise<void> {
  const ours = error instanceof PithyError;
  await emitControlPlaneAction(emit, {
    ...eventOf(call),
    outcome: ours || !fallback ? outcomeOf(error) : fallback.outcome,
    metadata: { reason: call.reason, changed: false, code: ours || !fallback ? codeOf(error) : fallback.code },
  });
}

/**
 * Run one lifecycle call and audit whatever the transition did not. `unchanged` says whether a result is a
 * call that changed nothing; the event for a call that did change something is the transition's own.
 */
export async function auditedLifecycleCall<T>(
  emit: AuditEmit,
  call: LifecycleCall,
  run: () => Promise<T>,
  unchanged: (result: T) => boolean,
): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (error) {
    await recordLifecycleRefusal(emit, call, error);
    throw error;
  }
  if (unchanged(result)) {
    await emitControlPlaneAction(emit, { ...eventOf(call), metadata: { reason: call.reason, changed: false } });
  }
  return result;
}
