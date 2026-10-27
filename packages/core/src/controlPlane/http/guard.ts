// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { MiddlewareHandler } from "hono";
import { type AuditEmit, noopEmit } from "../../audit/recorder";
import type { PithyHonoEnv } from "../../capability/capability";
import { commandName, remedy } from "../../cli/command";
import { type AmbientEnv, compositionEnvironment } from "../../env/ambient";
import { PithyError } from "../../error/pithyError";
import { workerVersionMetadata } from "../../worker/identity";
import { ControlPlaneAuditActions, safeEmit } from "../audit/actions";
import type { ControlPlaneContext } from "../context";
import type { ControlPlaneActorKind } from "../data/connection";
import {
  ControlPlaneInsufficientScopeError,
  ControlPlaneInvalidCredentialError,
  ControlPlaneNotConnectedError,
} from "../error/errors";
import type { ControlPlaneRequirement } from "../scope/scope";
import {
  CONTROL_PLANE_HEADER,
  CONTROL_PLANE_OIDC_HEADER,
  CONTROL_PLANE_SCOPE_HEADER,
  CONTROL_PLANE_TRUST_HEADER,
  CONTROL_PLANE_VERSION_CREATED_HEADER,
  CONTROL_PLANE_VERSION_HEADER,
} from "../wire";
import { type ControlPlaneVerifyDeps, verifyControlPlaneCall } from "./verify";
import { type ControlPlaneTrustVerifyDeps, verifyControlPlaneTrustCall } from "./verifyTrust";

/**
 * `requireControlPlane(scope)` — the gate every control-plane route wears, including the ones
 * capabilities contribute.
 *
 * ## Why a verifier on the request, and not a configured factory
 *
 * `@pithy-sh/payments` writes `requireControlPlane(PAYMENTS_ENTITLEMENT_GRANT_SCOPE)` at module scope. It cannot
 * hold the seam's config — that is the adopter's, resolved when they compose `controlplane()` — and it
 * must not import anything from a sibling package. So the seam contributes one middleware that puts a
 * {@link ControlPlaneVerifier} on the request, and the gate below consumes it. A capability depends on
 * a core seam and nothing else, which is principle 4 doing exactly what it exists for.
 *
 * ## It fails closed, and that is the point
 *
 * With no `controlplane()` composed there is no verifier, and every gate raises
 * `controlplane/not_connected`. A capability that contributes admin routes into a Worker that never
 * enabled the seam therefore denies them, rather than leaving them open because the thing meant to
 * protect them is absent. **A package that imports its authorization from elsewhere must deny when
 * that elsewhere is missing** — the same reason `requireAuth` is copied per capability rather than
 * imported from `@pithy-sh/auth`.
 *
 * ## The requirement is mandatory
 *
 * There is no zero-argument form. An optional scope is a thing you can forget, and forgetting it on an
 * admin route ships an unscoped one; requiring the argument means the only way to write a route with no
 * authorization is to name `ANY_VERIFIED_CALLER` out loud, which is as deliberate as naming a scope.
 */

/**
 * Verify one call against this Worker's registrations. Contributed by the seam's middleware, consumed
 * by {@link requireControlPlane}, and absent when the seam is not composed.
 */
export type ControlPlaneVerifier = (
  request: Request,
  requirement: ControlPlaneRequirement,
) => Promise<ControlPlaneContext>;

/**
 * Build the verifier the seam's middleware publishes. Split out from the middleware so the wiring is
 * testable without a Worker, and so `verify.ts` stays free of Hono.
 */
export function createControlPlaneVerifier(
  deps: ControlPlaneVerifyDeps,
  /**
   * The trust path's own dependencies (#722). Absent, a call presenting an OIDC token is refused like any other
   * credential this Worker cannot verify — the seam fails closed rather than waving an unverifiable token through.
   */
  trusts?: ControlPlaneTrustVerifyDeps,
): ControlPlaneVerifier {
  return async (request, requirement) => {
    // A call presents one credential. The OIDC header selects the trust path; both at once is refused rather
    // than resolved, because "which of these did the caller mean" is not a question a verifier should answer.
    const oidc = request.headers.get(CONTROL_PLANE_OIDC_HEADER);
    if (oidc !== null) {
      if (request.headers.get(CONTROL_PLANE_HEADER) !== null) {
        throw new ControlPlaneInvalidCredentialError({
          detail: "a call presented both a signed token and an OIDC token",
        });
      }
      if (!trusts) {
        throw new ControlPlaneInvalidCredentialError({
          detail: "an OIDC token was presented and this Worker verifies none",
        });
      }
      return await verifyControlPlaneTrustCall(
        {
          token: oidc,
          trustId: request.headers.get(CONTROL_PLANE_TRUST_HEADER) ?? undefined,
          scope: request.headers.get(CONTROL_PLANE_SCOPE_HEADER) ?? undefined,
          requirement,
        },
        trusts,
      );
    }
    // Clone before reading. The handler still has to parse this body through `validate`, and a stream
    // consumed here would reach it empty — the digest check would pass and the request would then fail
    // validation for no visible reason.
    const body = new Uint8Array(await request.clone().arrayBuffer());
    // `return await`, not `return`. Returning a promise from an async function makes this frame *adopt*
    // the rejection instead of raising it, and workerd then reports the adopted promise as an unhandled
    // rejection even though the gate catches it and `onError` answers correctly. Refusals are the normal
    // traffic of this seam — an expired token, an ungranted scope — so they must not read as runtime
    // faults in an adopter's logs. Same trap `submit()` in `@pithy-sh/payments` documents.
    return await verifyControlPlaneCall(
      { token: request.headers.get(CONTROL_PLANE_HEADER) ?? undefined, body, requirement },
      deps,
    );
  };
}

/**
 * What this Worker may say about its own build, as headers — everything the binding handed it, and
 * nothing else.
 *
 * A function rather than two lines in the middleware because this is where the seam's one invariant
 * lives and one invariant wants one place to be gated: **every value here was handed to this Worker by
 * the platform, byte for byte.** Nothing is defaulted, nothing is computed at request time, and a field
 * the binding did not carry produces no header at all. That last clause is the load-bearing one — this
 * pair is what a management client invalidates a rendered pane on, and an empty header is a value, so
 * "cannot say" has to arrive as silence rather than as an empty string a client can compare.
 *
 * The tag stays off the wire. It is read by the identity reader and answers neither of the two
 * questions a client asks, and this header crosses to a management client on adopter-authored text.
 */
export function workerVersionHeaders(env: unknown): Record<string, string> {
  const meta = workerVersionMetadata(env);
  const headers: Record<string, string> = {};
  if (meta.id !== null) headers[CONTROL_PLANE_VERSION_HEADER] = meta.id;
  if (meta.createdAt !== null) headers[CONTROL_PLANE_VERSION_CREATED_HEADER] = meta.createdAt;
  return headers;
}

/**
 * Require a verified control-plane caller carrying `requirement`.
 *
 * Goes **before** any validator on the route line. A validator ahead of the gate turns a 401 into a
 * 400 and tells an unauthenticated caller which requests were well-formed — on this seam that is a
 * live oracle, letting someone with no credential at all probe the shape of key registration.
 */
/**
 * The brand every {@link requireControlPlane} gate carries, so a mounted router can be read back.
 *
 * A middleware is an opaque function to Hono, so "which routes are control-plane routes" is knowable
 * only if the gate says so about itself. `undeclaredAdminRoutes` needs exactly that: it walks the
 * router looking for guarded routes nobody declared, and without a mark it would have to guess from
 * path shape. `Symbol.for` so the check still works across duplicated copies of this module.
 */
export const CONTROL_PLANE_GUARD = Symbol.for("pithy.controlPlaneGuard");

/** Whether a mounted handler is a control-plane gate. */
export function isControlPlaneGuard(handler: unknown): boolean {
  return typeof handler === "function" && (handler as unknown as Record<symbol, unknown>)[CONTROL_PLANE_GUARD] === true;
}

export function requireControlPlane(requirement: ControlPlaneRequirement): MiddlewareHandler<PithyHonoEnv> {
  return requireControlPlaneFor(async () => requirement);
}

/**
 * The scope a call needs, resolved from the call itself. Never throws: whatever it cannot read resolves to
 * a requirement, and `ANY_VERIFIED_CALLER` is the least it may resolve to — never no gate at all.
 */
export type ControlPlaneRequirementResolver = (
  c: Parameters<MiddlewareHandler<PithyHonoEnv>>[0],
) => Promise<ControlPlaneRequirement>;

/**
 * {@link requireControlPlane} for a route whose scope is named by the request, which is the presence ticket
 * route's case (#815): the room kind in its body decides the scope. Resolving it **inside the gate, before
 * verifying**, is what keeps a refused call to the one denial row every other route writes — a handler that
 * checked the scope after the gate let the call through would leave an allowed row ahead of its denial.
 */
export function requireControlPlaneFor(resolve: ControlPlaneRequirementResolver): MiddlewareHandler<PithyHonoEnv> {
  const guard: MiddlewareHandler<PithyHonoEnv> = async (c, next) => {
    const requirement = await resolve(c);
    // Every control-plane response carries the build that produced it, allowed or denied.
    //
    // **On the guard, not on the seam's own routes**, because the guard is the one thing every
    // control-plane route wears — including the ones capabilities contribute. Stamping it in
    // `manifestHandler` would give the header to the manifest and to nothing else.
    //
    // **Per response, not once at connect.** A client that captured the version when it connected is
    // holding a stale value the moment the adopter deploys — which is exactly when it matters. Per
    // response, each recorded action pins the build it actually hit, and a client can notice the version
    // changing mid-session, which is the moment a rendered pane has quietly gone out of date.
    //
    // **Two headers, because one value cannot answer both questions.** The id says which build; the
    // timestamp beside it says whether the same build has been deployed again, which an id compared
    // against an id can never report. `workerVersionHeaders` owns what may be said and what absence
    // means; `workerBuildChanged` in `../wire` owns how the pair is read.
    for (const [name, value] of Object.entries(workerVersionHeaders(c.env))) c.header(name, value);

    const verify = c.var.controlPlaneVerifier;
    if (!verify) {
      const denial = new ControlPlaneNotConnectedError({
        message: "This deployment does not accept management-client calls.",
        action: `Add \`controlplane()\` to this Worker's pithy.config.ts, then ${connectStep(compositionEnvironment(c.env as unknown as AmbientEnv))}.`,
        detail: "no control-plane verifier on the request — the controlplane capability is not composed",
      });
      await auditDenial(c, requirement, denial);
      throw denial;
    }

    let context: ControlPlaneContext;
    try {
      context = await verify(c.req.raw, requirement);
    } catch (cause) {
      await auditDenial(c, requirement, cause);
      throw cause;
    }

    c.set("controlPlane", context);
    // Every control-plane row this call writes says which kind of client wrote it (#721). Stamped here,
    // once, rather than at each of the dozens of emit sites across the capabilities, because a rule kept
    // at the call sites regrows the moment someone adds one — and `actorType` alone names an agent, the
    // dashboard and a script identically.
    c.set("emit", stampActorKind(c.var.emit, context.actorKind));
    await safeEmit(
      c.var.emit,
      {
        action: ControlPlaneAuditActions.callAllowed,
        outcome: "success",
        actorType: "control-plane",
        actorId: context.subject,
        resourceType: "controlplane_connection",
        resourceId: context.connectionId,
        requestId: c.req.header("cf-ray"),
        ip: c.req.header("cf-connecting-ip"),
        userAgent: c.req.header("user-agent"),
        metadata: {
          connectionId: context.connectionId,
          connectionEnvironment: context.environment,
          scope: context.scope,
          keyId: context.keyId,
          // Said only for a trust, so a row written by a key reads exactly as it did before trusts existed.
          ...(context.credentialKind === "trust" ? { credentialKind: "trust" } : {}),
          method: c.req.method,
          path: c.req.path,
        },
      },
      c.var.log,
    );
    // A handler can refuse a call the gate's requirement let through — an operator roster write that
    // would move the owning role is refused `controlplane/insufficient_scope`, naming the ownership route,
    // even on a connection granted `organization:ownership:transfer`, because a token exercises the one
    // scope it was minted for — and it refuses it itself, past this gate. That refusal is still a blocked attempt, and the trail must
    // say so: `call_allowed` alone would hide a credential probing for the grant it lacks.
    //
    // Both paths, as the organization routes' refusal recorder reads them: a throw that reaches here, and
    // `c.error`, which is where Hono's `compose` leaves a downstream throw it rendered through `onError`.
    try {
      await next();
    } catch (error) {
      await auditHandlerDenial(c, requirement, context, error);
      throw error;
    }
    await auditHandlerDenial(c, requirement, context, c.error);
  };
  (guard as unknown as Record<symbol, unknown>)[CONTROL_PLANE_GUARD] = true;
  return guard;
}

/**
 * The recorder a verified call's handlers write through: the request's own, with the connection's actor
 * kind added to every `control-plane` event that does not already carry one.
 *
 * Only `control-plane` events, because the kind describes a management client and nothing else — a
 * handler recording what happened to a user is recording a user. An event that states a kind keeps it.
 * A connection with no recorded kind adds nothing, so its rows read exactly as they did before.
 *
 * The no-op comes back as itself: there is nothing to stamp, and a wrapper around it would hide that nothing is
 * recorded from every reader past this gate — the evidence pack's `controlPlaneCallsRecorded` among them (#821).
 */
export function stampActorKind(emit: AuditEmit, actorKind: ControlPlaneActorKind | null): AuditEmit {
  if (actorKind === null || emit === noopEmit) return emit;
  return (event) =>
    emit(event.actorType === "control-plane" && event.actorKind == null ? { ...event, actorKind } : event);
}

/**
 * Record a refused call.
 *
 * **Denials are audited, not only successes.** `denied` is a first-class outcome precisely for this, and
 * this is the surface where an unaudited blocked attempt is least acceptable — a run of them is what a
 * credential being probed looks like, and it is invisible if only the successes are written down.
 *
 * The reason lands in `metadata.reason` from the error's `code`, never from its `detail`: `detail` names
 * the exact verification step, and the audit trail is queryable and long-lived. The step belongs in the
 * log, which is bounded and already carries the whole payload.
 *
 * **Attributed exactly as far as it is proven (#812).** A call that failed verification — no connection, a bad
 * signature, an unknown or expired key — names nobody, because nothing about it is proven. A call whose credential
 * verified and whose scope was not granted is a known connection asking for an operation it lacks, which is what
 * scope probing looks like, so its row carries the subject as `actorId`, the connection as its resource, the key
 * in `metadata.keyId` (and `credentialKind: "trust"` when that key is a trust), and the connection's `actorKind` — the same four the allowed row carries. Only the first presentation of a token is: the verifier
 * spends the jti of a scope refusal and names no caller on a token already spent, because a signature proves who minted
 * a token, not who presented it. Only the row changes; the error thrown is the same.
 *
 * Nothing here can turn a correct denial into a 500 — `safeEmit` swallows, and the caller rethrows the
 * original error regardless.
 */
async function auditDenial(
  c: Parameters<MiddlewareHandler<PithyHonoEnv>>[0],
  requirement: ControlPlaneRequirement,
  cause: unknown,
): Promise<void> {
  const code = cause instanceof PithyError ? cause.payload.code : "core/internal";
  const proven = cause instanceof ControlPlaneInsufficientScopeError ? cause.caller : null;
  // A claim mismatch on an OIDC token whose signature, issuer and audience verified (#722): the claims it carried
  // are recorded, which is how an operator picks a matcher for a custom issuer. Nobody is named as the actor — the
  // token is genuine, but not for any workload this Worker trusts.
  const refusedTrust = cause instanceof ControlPlaneInvalidCredentialError ? cause.refusedTrust : null;
  const metadata = {
    reason: code,
    required: String(requirement),
    method: c.req.method,
    path: c.req.path,
    ...(refusedTrust
      ? {
          connectionId: refusedTrust.connectionId,
          trustId: refusedTrust.trustId,
          observedClaims: { ...refusedTrust.observedClaims },
        }
      : {}),
  };
  await safeEmit(
    c.var.emit,
    {
      action: ControlPlaneAuditActions.callDenied,
      outcome: "denied",
      severity: "warning",
      actorType: "control-plane",
      // The connection's own kind, as `stampActorKind` adds it to the allowed row, so a trail filtered on kind holds a
      // client's refusals beside its calls. Absent when unproven, and absent for a connection with no recorded kind.
      ...(proven?.actorKind ? { actorKind: proven.actorKind } : {}),
      // Null unless proven. The `sub` claim of a call that failed verification is unproven, and writing an
      // unverified identity into the trail as the actor is how a forged token gets to name someone. A scope refusal
      // came after the signature verified, so its subject is the token's real one.
      actorId: proven?.subject ?? null,
      ...(proven ? { resourceType: "controlplane_connection", resourceId: proven.connectionId } : {}),
      requestId: c.req.header("cf-ray"),
      ip: c.req.header("cf-connecting-ip"),
      userAgent: c.req.header("user-agent"),
      metadata: proven
        ? {
            ...metadata,
            keyId: proven.keyId,
            ...(proven.credentialKind === "trust" ? { credentialKind: "trust" } : {}),
          }
        : metadata,
    },
    c.var.log,
  );
}

/**
 * Record a scope refusal a handler raised after the gate let the call in.
 *
 * Only `controlplane/insufficient_scope`: every other refusal past the gate is the handler's own to
 * record, and a 404 or a validation error is not a credential reaching beyond its grant. The same row as
 * {@link auditDenial}, with two differences that follow from the call having been verified: the actor is
 * the proven subject and its connection, and `refusedBy` says the gate passed it — `required` is the
 * gate's requirement, which this call met; what it lacked is in the log, with the rest of `detail`.
 * `scope`, `keyId` and `credentialKind` name the refused credential exactly as the gate's `call_allowed` row does, so a
 * read of one key's reach (#828) finds its refusals too, even on a request with no `cf-ray` to join by.
 */
async function auditHandlerDenial(
  c: Parameters<MiddlewareHandler<PithyHonoEnv>>[0],
  requirement: ControlPlaneRequirement,
  context: ControlPlaneContext,
  cause: unknown,
): Promise<void> {
  // Read by its code, not `instanceof`: a capability that throws it may hold its own copy of this module,
  // and a refusal that slipped past a class check would be exactly the unaudited attempt this exists for.
  const code = (cause as { payload?: { code?: unknown } } | null)?.payload?.code;
  if (code !== "controlplane/insufficient_scope") return;
  await safeEmit(
    c.var.emit,
    {
      action: ControlPlaneAuditActions.callDenied,
      outcome: "denied",
      severity: "warning",
      actorType: "control-plane",
      actorId: context.subject,
      resourceType: "controlplane_connection",
      resourceId: context.connectionId,
      requestId: c.req.header("cf-ray"),
      ip: c.req.header("cf-connecting-ip"),
      userAgent: c.req.header("user-agent"),
      metadata: {
        reason: code,
        required: String(requirement),
        refusedBy: "handler",
        connectionId: context.connectionId,
        scope: context.scope,
        keyId: context.keyId,
        ...(context.credentialKind === "trust" ? { credentialKind: "trust" } : {}),
        method: c.req.method,
        path: c.req.path,
      },
    },
    c.var.log,
  );
}

/**
 * The step that connects a management client, as this deployed Worker can name it: with its own environment when
 * it knows it, and never with a Worker — it cannot know the `apps/` directory that provisioned it (#711).
 */
function connectStep(env: string | undefined): string {
  if (env === undefined)
    return `connect one with ${commandName("dashboard connect")}, naming this environment with --env`;
  return remedy("dashboard connect", { flags: { "--env": env } }, { runtime: true }).say((command) => `run ${command}`);
}
