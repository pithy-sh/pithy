// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { zValidator } from "@hono/zod-validator";
import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import { requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import type { ControlPlaneScope } from "@pithy-sh/core/src/controlPlane/scope/scope";
import { pageLimit } from "@pithy-sh/core/src/data/cursor";
import { InternalError } from "@pithy-sh/core/src/error/pithyError";
import { validationHook } from "@pithy-sh/core/src/http/validation";
import type { VerificationStrategy } from "@pithy-sh/core/src/http/verification";
import type { Context, Hono } from "hono";
import { dueForRotation } from "../admin/health";
import { readSecretRotations, readSecretStatus } from "../admin/status";
import { type SecretsAuditAction, SecretsAuditActions } from "../audit/actions";
import { secretsStatusDatabase } from "../data/statusDb";
import { SecretNotFoundError } from "../error/errors";
import type { SecretRegistry } from "../registry";
import { SECRETS_STATUS_READ_SCOPE } from "./guards";
import type { SecretRotationsResponse, SecretsStatusResponse } from "./responses";
import { RotationsQuery, SecretNameParam } from "./schemas";
import { secretRotationView, secretStatusView } from "./view";

/**
 * The secrets capability's management surface — two reads, both control-plane, both metadata:
 *
 *   GET /secrets/admin/status                  → every declared secret's status   (control-plane: secrets:status:read)
 *   GET /secrets/admin/status/:name/rotations  → one secret's rotation history    (control-plane: secrets:status:read)  param: SecretNameParam, query: RotationsQuery
 *
 * This is the capability's **first** HTTP surface, and it is deliberately the whole of it. The write
 * path — create, update, delete, rotate — already exists and already has an operator: the `pithy
 * secrets` CLI dispatching to the per-environment manager Worker, with the adopter's own registry and
 * schemas loaded from their repo. A management client holds neither, so a write here could not validate
 * a value against the schema that governs it (`management/writeSecret.ts` explains why the Worker
 * cannot be that validator). A route that writes a secret it cannot check is not a feature.
 *
 * ## There is no route that reads a value, and there is no scope that could grant one
 *
 * Not an omission to be filled in later. The whole point of storing secrets in the customer's own D1,
 * under a master key their Worker holds, is that no third party has a path to a plaintext. A route here
 * would be that path, and it would exist in every deployment whether or not anybody granted it.
 *
 * ## `requireAuth()` is never on these lines
 *
 * The seam leaves `c.var.auth` null on a control-plane call by design, so an auth gate would deny every
 * legitimate management call permanently and no credential could fix it. `requireControlPlane`
 * **replaces** it; it does not stack with it.
 *
 * Validators sit **after** the guard on every route line: an unverified caller is turned away before its
 * request is parsed, so a malformed request can never downgrade a 403 to a 400 and tell a caller with no
 * credential which requests were well-formed. On a surface that enumerates a project's credentials, that
 * is a live oracle.
 */

/**
 * Where the secrets management surface mounts when an adopter names nothing.
 *
 * Exported because two places must agree on it: the router below, and `secretsAdminRoutes` in
 * `guards.ts`. A default living only in the registrar would let the manifest advertise `/secrets/...`
 * while the routes mounted somewhere else, and a management client composing its calls from the
 * manifest would 404 with nothing to diagnose.
 */
export const SECRETS_DEFAULT_BASE_PATH = "/secrets";

/**
 * What every route this capability mounts declares: its path, its verification strategy, and the
 * control-plane scope it checks.
 *
 * Exported so a test can assert against the declaration rather than against a middleware count.
 * Counting middleware proves that *something* runs before the handler; it cannot prove *what*, and a
 * bare `zValidator` satisfies a count. `routeContract.test.ts` checks this list against the routes Hono
 * actually registered in both directions.
 */
export interface SecretsRouteDeclaration {
  readonly method: "GET";
  /** The path relative to the configured `basePath`, e.g. `/admin/status`. */
  readonly path: string;
  readonly strategy: VerificationStrategy;
  /** The control-plane scope this route checks. */
  readonly scope: ControlPlaneScope;
}

/** Every route, and how it is gated. */
export const SECRETS_ROUTES: readonly SecretsRouteDeclaration[] = [
  { method: "GET", path: "/admin/status", strategy: "control-plane", scope: SECRETS_STATUS_READ_SCOPE },
  { method: "GET", path: "/admin/status/:name/rotations", strategy: "control-plane", scope: SECRETS_STATUS_READ_SCOPE },
];

export interface SecretsRoutesOptions {
  /**
   * The registry to report over, read **per request** rather than captured.
   *
   * A function, because the set worth reporting is not the one this capability was constructed with. The
   * combined registry — every composed capability's slice, auth's signing key and email's link key
   * included — only exists once `compose` has run, which is after the router is built. Capturing the
   * value here would report the adopter's own secrets and silently omit every capability's, which is
   * most of them.
   */
  registry: () => SecretRegistry;
  /** Mount the surface somewhere other than `/secrets`. Moves the advertised paths with it. */
  basePath?: string;
}

/**
 * The verified management client behind a control-plane call.
 *
 * `requireControlPlane()` has run on every route that calls this, so `c.var.controlPlane` is populated
 * by the time a handler reads it. The throw is a programming-error guard rather than a runtime path:
 * reaching it would mean a management route was mounted without its gate, which is the one mistake this
 * file is arranged to make impossible.
 */
function caller(c: Context<PithyHonoEnv>): ControlPlaneContext {
  const context = c.var.controlPlane;
  if (!context) {
    throw new InternalError({
      message: "The secrets surface could not identify the management caller.",
      detail: "requireControlPlane() must run before a secrets management handler reads the caller.",
    });
  }
  return context;
}

/** Record a management read. Names and counts only — there is nothing else to record, by construction. */
async function record(
  c: Context<PithyHonoEnv>,
  action: SecretsAuditAction,
  resourceId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  const who = caller(c);
  await c.var.emit({
    action,
    outcome: "success",
    actorType: "control-plane",
    actorId: who.subject,
    resourceType: "secret",
    resourceId,
    requestId: c.req.header("cf-ray"),
    ip: c.req.header("cf-connecting-ip"),
    userAgent: c.req.header("user-agent"),
    metadata: { connectionId: who.connectionId, ...metadata },
  });
}

export function registerSecretsRoutes(options: SecretsRoutesOptions): (app: Hono<PithyHonoEnv>) => void {
  const base = options.basePath ?? SECRETS_DEFAULT_BASE_PATH;

  return (app) => {
    app.get(`${base}/admin/status`, requireControlPlane(SECRETS_STATUS_READ_SCOPE), async (c) => {
      const statuses = await readSecretStatus(secretsStatusDatabase(c), options.registry());
      await record(c, SecretsAuditActions.statusRead, null, {
        declared: statuses.length,
        overdue: dueForRotation(statuses),
      });
      return c.json({ secrets: statuses.map(secretStatusView) } satisfies SecretsStatusResponse, 200);
    });

    app.get(
      `${base}/admin/status/:name/rotations`,
      requireControlPlane(SECRETS_STATUS_READ_SCOPE),
      zValidator("param", SecretNameParam, validationHook),
      zValidator("query", RotationsQuery, validationHook),
      async (c) => {
        const { name } = c.req.valid("param");
        const entry = options.registry()[name];
        // Membership is the gate, not the string's shape. Without it this route would read rotation rows
        // by arbitrary name — including the sentinel the whole-store key rotation records itself under,
        // and any row left by a secret since removed from the registry.
        if (!entry || entry.keyed) {
          throw new SecretNotFoundError({
            message: `No secret named '${name}' is declared.`,
            action: "Read the declared names from the status listing.",
            detail: `secret status: '${name}' is not a named entry of the composed registry`,
          });
        }
        const rotations = await readSecretRotations(
          secretsStatusDatabase(c),
          name,
          pageLimit(c.req.valid("query").limit),
        );
        await record(c, SecretsAuditActions.rotationsRead, name, { name, returned: rotations.length });
        return c.json({ name, rotations: rotations.map(secretRotationView) } satisfies SecretRotationsResponse, 200);
      },
    );
  };
}
