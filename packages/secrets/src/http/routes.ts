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
import type { SecretRegistry, SecretRegistryEntry } from "../registry";
import type { SecretRotationOutcome } from "../rotation/rotateValue";
import { SECRETS_ROTATE_SCOPE, SECRETS_STATUS_READ_SCOPE } from "./guards";
import type { SecretRotateResponse, SecretRotationsResponse, SecretsStatusResponse } from "./responses";
import { runWorkerRotation, workerRotationDeps, workerRotationEnvironment } from "./rotate";
import { RotationsQuery, SecretNameParam } from "./schemas";
import { secretRotationOutcomeView, secretRotationView, secretStatusView } from "./view";

/**
 * The secrets capability's management surface — two reads and one write, all control-plane, none of them
 * carrying a value:
 *
 *   GET  /secrets/admin/status                  → every declared secret's status   (control-plane: secrets:status:read)
 *   GET  /secrets/admin/status/:name/rotations  → one secret's rotation history    (control-plane: secrets:status:read)  param: SecretNameParam, query: RotationsQuery
 *   POST /secrets/admin/status/:name/rotate     → replace one secret, here         (control-plane: secrets:rotate)       param: SecretNameParam
 *
 * ## The write is a rotation and nothing else, and that is what makes it possible
 *
 * This surface was two reads because **a management client cannot supply a value.** It holds neither the
 * adopter's registry nor their Zod schemas, so a create or an update here would write a value against a
 * schema it could not check (`management/writeSecret.ts` explains why the Worker cannot be that
 * validator), and a route that writes a secret it cannot check is not a feature.
 *
 * A rotation supplies nothing. The successor is produced *inside* the Worker — minted from the entry's own
 * recipe for a `local` secret, or returned by the rotator the registry entry carries for a `provider` one —
 * so the value never crosses a boundary in either direction, and the schema that governs it is the one that
 * produced it. That is the whole of why this write can exist where create and update still cannot, and it
 * is a fact about rotation rather than an exception granted to it.
 *
 * **What a Worker can rotate is narrower than what the CLI can**, and `./rotate.ts` is where that is argued
 * and refused: one environment's D1, its own master key, and nothing that lives in Cloudflare's Secrets
 * Store or has to be identical across environments.
 *
 * ## There is no route that reads a value, and there is no scope that could grant one
 *
 * Not an omission to be filled in later. The whole point of storing secrets in the customer's own D1,
 * under a master key their Worker holds, is that no third party has a path to a plaintext. A route here
 * would be that path, and it would exist in every deployment whether or not anybody granted it. The
 * rotation route does not weaken this: it produces a value, stores it, and answers with a shape that has no
 * field one could sit in (`SecretRotationOutcomeView`). A rotation that cannot store its successor discards
 * it and says so — it never hands it back rather than lose it.
 *
 * ## The rotation is a `POST` with no body, and CSRF has nothing to ride
 *
 * `control-plane` is not a cookie strategy. `requireControlPlane` verifies a detached EdDSA token in the
 * `CONTROL_PLANE_HEADER`, signed over the request body, against a key the adopter registered — there is no
 * ambient credential a browser attaches on its own, so a cross-site form post carries no authority. CSRF
 * middleware belongs with `session`, and stacking it here would guard a door that has no hinge. The route
 * takes **no body at all**: everything it needs is the `:name` it is addressed at and the environment its
 * own verified context names, and a body it does not read is a body nobody can smuggle a value into.
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
  readonly method: "GET" | "POST";
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
  { method: "POST", path: "/admin/status/:name/rotate", strategy: "control-plane", scope: SECRETS_ROTATE_SCOPE },
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

/**
 * The registry entry this call is addressed at, or a 404.
 *
 * **Membership is the gate, not the string's shape.** Without it the history route would read rotation
 * rows by arbitrary name — including the sentinel the whole-store key rotation records itself under, and
 * any row left by a secret since removed from the registry — and the rotation route would be pointed at a
 * name no capability has ever declared. A keyed entry is refused with the rest: a keyspace has no single
 * value, so neither call has an answer for one.
 */
function declared(registry: SecretRegistry, name: string): SecretRegistryEntry {
  const entry = registry[name];
  if (!entry || entry.keyed) {
    throw new SecretNotFoundError({
      message: `No secret named '${name}' is declared.`,
      action: "Read the declared names from the status listing.",
      detail: `secret status: '${name}' is not a named entry of the composed registry`,
    });
  }
  return entry;
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

/**
 * Record a rotation — the one administrative act on this surface, on success and on failure alike.
 *
 * `severity` is the field an incident review scans, and `unrecorded` is `critical` because it is the only
 * outcome here that leaves a system broken: a credential dead at its issuer and its successor never stored.
 * `rollFailed` is written down rather than left to be inferred from an empty `recorded`, because *was
 * rolled* and *may have been rolled* is the distinction the review turns on and the two are the same
 * absence otherwise.
 *
 * Names, environments and flags. Nothing about a value is here, and nothing about one is available to put
 * here — `SecretRotationOutcome` has no field that could carry one.
 */
async function recordRotation(c: Context<PithyHonoEnv>, outcome: SecretRotationOutcome): Promise<void> {
  const who = caller(c);
  await c.var.emit({
    action: SecretsAuditActions.rotated,
    outcome: outcome.status === "rotated" ? "success" : "failure",
    severity: outcome.status === "unrecorded" ? "critical" : "warning",
    actorType: "control-plane",
    actorId: who.subject,
    resourceType: "secret",
    resourceId: outcome.name,
    requestId: c.req.header("cf-ray"),
    ip: c.req.header("cf-connecting-ip"),
    userAgent: c.req.header("user-agent"),
    metadata: {
      connectionId: who.connectionId,
      name: outcome.name,
      status: outcome.status,
      rotation: outcome.kind,
      rolled: outcome.rolled,
      environments: outcome.recorded,
      ...(outcome.rollFailed === undefined ? {} : { rollFailed: outcome.rollFailed }),
      ...(outcome.stranded.length > 0 ? { stranded: outcome.stranded } : {}),
    },
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
        declared(options.registry(), name);
        const rotations = await readSecretRotations(
          secretsStatusDatabase(c),
          name,
          pageLimit(c.req.valid("query").limit),
        );
        await record(c, SecretsAuditActions.rotationsRead, name, { name, returned: rotations.length });
        return c.json({ name, rotations: rotations.map(secretRotationView) } satisfies SecretRotationsResponse, 200);
      },
    );

    app.post(
      `${base}/admin/status/:name/rotate`,
      requireControlPlane(SECRETS_ROTATE_SCOPE),
      zValidator("param", SecretNameParam, validationHook),
      async (c) => {
        const { name } = c.req.valid("param");
        const who = caller(c);
        const entry = declared(options.registry(), name);
        const outcome = await runWorkerRotation(await workerRotationDeps(c), {
          name,
          entry,
          // From the verified context, not from a body and not from a raw binding. A caller cannot name
          // the environment it wants to write, because a caller naming an environment would be a caller
          // choosing which of the adopter's deployments to touch.
          environment: workerRotationEnvironment(who.environment),
          actor: who.subject,
        });
        // Audited on both outcomes, and never for a rotation that did nothing — a trail logging a
        // rotation for a secret nothing touched is a trail nobody can read. The metadata is the same set
        // `pithy secrets rotate` records, so one query answers the question whichever door was used.
        if (outcome.status !== "unchanged") {
          await recordRotation(c, outcome);
        }
        return c.json({ rotation: secretRotationOutcomeView(outcome) } satisfies SecretRotateResponse, 200);
      },
    );
  };
}
