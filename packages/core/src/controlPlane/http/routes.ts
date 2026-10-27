// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { Hono } from "hono";
import type { PithyHonoEnv } from "../../capability/capability";
import { describeRoute } from "../../http/routeSpec";
import { validate } from "../../http/validation";
import { PresenceTicket } from "../../presence/http/responses";
import { ControlPlanePresenceTicketRequest } from "../../presence/http/schemas";
import { type AdminRoute, ControlPlaneManifest } from "../discovery/adminRoute";
import {
  ANY_VERIFIED_CALLER,
  KEYS_ROTATE_SCOPE,
  MANIFEST_READ_SCOPE,
  MIGRATIONS_READ_SCOPE,
  PRIVACY_READ_SCOPE,
} from "../scope/scope";
import { requireControlPlane } from "./guard";
import {
  type ControlPlaneHandlerDeps,
  expireKeyHandler,
  listKeysHandler,
  manifestHandler,
  migrationsHandler,
  pingHandler,
  privacyHandler,
  registerKeyHandler,
} from "./handlers";
import { presenceTicketGate, presenceTicketHandler } from "./presence";
import {
  ControlPlaneKeysResponse,
  ControlPlaneMigrationsResponse,
  ControlPlanePingResponse,
  ControlPlanePrivacyResponse,
  ExpireKeyResponse,
  RegisterKeyResponse,
} from "./responses";
import { ExpireKeyParams, ExpireKeyRequest, RegisterKeyRequest } from "./schemas";

/**
 * The seam's own routes, distinct from the admin routes capabilities contribute.
 *
 *   GET  /control-plane/ping                  → connectivity and key proof   (any verified caller)
 *   GET  /control-plane/manifest              → what this Worker composes    (manifest:read)
 *   GET  /control-plane/keys                  → the registration state       (keys:rotate)
 *   POST /control-plane/keys                  → register a key               (keys:rotate)
 *   POST /control-plane/keys/:keyId/expire    → retire a superseded key      (keys:rotate)
 *   GET  /control-plane/migrations            → where each database stands   (migrations:read)
 *   GET  /control-plane/privacy               → what each schema holds        (privacy:read)
 *   POST /control-plane/presence/tickets      → a ticket into a presence room (the room kind's scope)
 *
 * Every one is `control-plane` and default-denied — with no connection registered they all answer 403,
 * and that is the shipped state of a Worker nobody has connected.
 *
 * **Guards precede validators on every line.** A validator first would turn a 401 into a 400 and tell a
 * caller with no credential which request shapes were well-formed. On these routes that is a live
 * oracle over key registration, which is the last thing that should be probeable.
 *
 * The three key routes share one scope. Reading which keys are live, registering the next one, and
 * retiring the last are one lifecycle, and an adopter deciding whether a management client may touch
 * their keys is making one decision, not three.
 *
 * The table is declared twice on purpose — once as descriptors a client can read, once as the
 * registrations themselves — and `routeContract.test.ts` proves the two agree.
 */

/**
 * The seam's own routes, described for `GET /control-plane/manifest`.
 *
 * Derived from the same `basePath` the routes below mount on, so the two cannot disagree — and the
 * seam holds itself to the rule it imposes on every capability: `controlPlaneRouteDescriptors` is
 * checked against the mounted router by `missingAdminRoutes` in `routeContract.test.ts`.
 *
 * `ping` carries a null scope. It requires a verified caller and no authorization, and saying so is
 * how a client knows it can always prove a key — including on a connection granted nothing at all.
 */
export function controlPlaneRouteDescriptors(basePath: string): AdminRoute[] {
  return [
    {
      method: "GET",
      path: `${basePath}/ping`,
      scope: null,
      summary: "Prove connectivity and which key answered. Always available to a verified caller.",
    },
    {
      method: "GET",
      path: `${basePath}/manifest`,
      scope: MANIFEST_READ_SCOPE,
      summary: "What this Worker composes, and how to call each capability's admin surface.",
    },
    {
      method: "GET",
      path: `${basePath}/keys`,
      scope: KEYS_ROTATE_SCOPE,
      summary: "The registered keys, their validity windows, and their ages.",
    },
    {
      method: "POST",
      path: `${basePath}/keys`,
      scope: KEYS_ROTATE_SCOPE,
      summary: "Register a successor public key. Signed with the key it replaces; appends only.",
    },
    {
      method: "POST",
      path: `${basePath}/keys/:keyId/expire`,
      scope: KEYS_ROTATE_SCOPE,
      summary: "Retire a superseded key. Must be signed with the successor it names as proven.",
    },
    {
      method: "GET",
      path: `${basePath}/migrations`,
      scope: MIGRATIONS_READ_SCOPE,
      summary:
        "What each bound database has applied, what is pending, what is undeclared, and which run put it there. Undeclared is relative to this Worker.",
    },
    {
      method: "GET",
      path: `${basePath}/privacy`,
      scope: PRIVACY_READ_SCOPE,
      summary:
        "Every stored schema holding a privacy-marked field, each field's path and class, and where it lives. Derived from the running code.",
    },
    {
      method: "POST",
      path: `${basePath}/presence/tickets`,
      // Null because no one scope covers it: the call needs the scope of the room kind its body names, which
      // each kind states in the manifest. Its gate resolves that scope from the body and verifies against it.
      scope: null,
      summary:
        "Mint a single-use ticket into one presence room. Needs the room kind's own scope, which the manifest lists beside each kind.",
    },
  ];
}

export function registerControlPlaneRoutes(
  app: Hono<PithyHonoEnv>,
  basePath: string,
  deps: ControlPlaneHandlerDeps,
): void {
  app.get(
    `${basePath}/ping`,
    describeRoute({
      summary: "Prove the connection and the key it signs with.",
      verification: "control-plane",
      responses: { 200: ControlPlanePingResponse },
    }),
    requireControlPlane(ANY_VERIFIED_CALLER),
    pingHandler(deps),
  );

  app.get(
    `${basePath}/manifest`,
    describeRoute({
      summary: "Describe what this Worker composes and how to call its admin surface.",
      verification: "control-plane",
      scopes: [MANIFEST_READ_SCOPE],
      responses: { 200: ControlPlaneManifest },
    }),
    requireControlPlane(MANIFEST_READ_SCOPE),
    manifestHandler(deps),
  );

  app.get(
    `${basePath}/keys`,
    describeRoute({
      summary: "Read the connection's key registration state.",
      verification: "control-plane",
      scopes: [KEYS_ROTATE_SCOPE],
      responses: { 200: ControlPlaneKeysResponse },
    }),
    requireControlPlane(KEYS_ROTATE_SCOPE),
    listKeysHandler(deps),
  );

  app.post(
    `${basePath}/keys`,
    describeRoute({
      summary: "Register a key for the connection.",
      verification: "control-plane",
      scopes: [KEYS_ROTATE_SCOPE],
      responses: { 201: RegisterKeyResponse },
    }),
    requireControlPlane(KEYS_ROTATE_SCOPE),
    validate("json", RegisterKeyRequest),
    (c) => registerKeyHandler(deps)(c, c.req.valid("json")),
  );

  app.post(
    `${basePath}/keys/:keyId/expire`,
    describeRoute({
      summary: "Retire a superseded key.",
      description: "Must be signed with the successor it names as proven.",
      verification: "control-plane",
      scopes: [KEYS_ROTATE_SCOPE],
      responses: { 200: ExpireKeyResponse },
    }),
    requireControlPlane(KEYS_ROTATE_SCOPE),
    validate("param", ExpireKeyParams),
    validate("json", ExpireKeyRequest),
    (c) => expireKeyHandler(deps)(c, c.req.valid("param"), c.req.valid("json")),
  );

  app.get(
    `${basePath}/migrations`,
    describeRoute({
      summary: "Report where each database this Worker binds stands.",
      description:
        "Applied, pending and undeclared migrations per database, each naming its namespace, and the last group with whether it is still reversible. Undeclared is relative to this Worker: a database shared with another Worker lists that Worker's migrations there. Read-only.",
      verification: "control-plane",
      scopes: [MIGRATIONS_READ_SCOPE],
      responses: { 200: ControlPlaneMigrationsResponse },
    }),
    requireControlPlane(MIGRATIONS_READ_SCOPE),
    migrationsHandler(deps),
  );

  app.get(
    `${basePath}/privacy`,
    describeRoute({
      summary: "Report every stored field marked with a privacy class.",
      description:
        "Every D1 table and KV store this Worker composed that holds a privacy-marked field, with each field's path, its class and where it is stored, beside the declared-and-observed posture. Derived at runtime from the deployed schemas. Read-only.",
      verification: "control-plane",
      scopes: [PRIVACY_READ_SCOPE],
      responses: { 200: ControlPlanePrivacyResponse },
    }),
    requireControlPlane(PRIVACY_READ_SCOPE),
    privacyHandler(deps),
  );

  app.post(
    `${basePath}/presence/tickets`,
    describeRoute({
      summary: "Mint a presence ticket for a management client.",
      description:
        "Admits the participant the body names to one room of any kind this Worker composes. Sign the call with the room kind's own scope, as the manifest lists it; presence adds no scope. Single use, for 60 seconds. Open the socket at `socketPath`, offering `protocol` and `pithy.ticket.<ticket>` in `Sec-WebSocket-Protocol`.",
      verification: "control-plane",
      responses: { 201: PresenceTicket },
    }),
    presenceTicketGate(deps),
    validate("json", ControlPlanePresenceTicketRequest),
    (c) => presenceTicketHandler(deps)(c, c.req.valid("json")),
  );
}
